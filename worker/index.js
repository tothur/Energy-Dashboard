import { refreshEnergySnapshot } from "./energy-service.js";

const SNAPSHOT_KEY = "latest";
const REFRESH_AFTER_MS = 2 * 60_000;
const STALE_AFTER_MS = 10 * 60_000;
const LOCK_TIMEOUT_MS = 2 * 60_000;
const GITHUB_PAGES_ORIGIN = "https://tothur.github.io/Energy-Dashboard";
let activeRefresh = null;

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

async function hasValidRefreshToken(request, env) {
  const expected = env.SITES_REFRESH_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || !provided) return false;

  const encoder = new TextEncoder();
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(providedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function hasHistoricalMix(data) {
  return data?.schemaVersion === 5
    && Number.isFinite(data?.system?.plantGenerationMW)
    && Number.isFinite(data?.system?.estimatedDistributedSolarMW)
    && Array.isArray(data?.history24h)
    && data.history24h.length > 0
    && Array.isArray(data?.loadHistory24h)
    && data.loadHistory24h.length > 0
    && ["actualMW", "plannedMW", "deviationMW"].every((key) => Number.isFinite(data.loadHistory24h.at(-1)?.[key]))
    && ["nuclearMW", "solarMW", "fossilMW", "renewableMW", "otherMW", "plantGenerationMW", "estimatedDistributedSolarMW"]
      .every((key) => Number.isFinite(data.history24h.at(-1)?.[key]));
}

async function ensureSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS energy_snapshot (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      measured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      refresh_started_at TEXT
    )
  `).run();
}

async function readStored(db) {
  const row = await db.prepare(
    "SELECT payload, measured_at AS measuredAt, updated_at AS updatedAt, refresh_started_at AS refreshStartedAt FROM energy_snapshot WHERE key = ?",
  ).bind(SNAPSHOT_KEY).first();
  if (!row) return null;
  return { ...row, data: JSON.parse(row.payload) };
}

async function readSeed(request, env) {
  const seedUrl = new URL("/data/energy-latest.json", request.url);
  const response = await env.ASSETS.fetch(new Request(seedUrl));
  if (!response.ok) throw new Error(`Bundled snapshot is unavailable: HTTP ${response.status}`);
  return response.json();
}

async function seedStored(db, data) {
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT OR IGNORE INTO energy_snapshot (key, payload, measured_at, updated_at, refresh_started_at) VALUES (?, ?, ?, ?, NULL)",
  ).bind(SNAPSHOT_KEY, JSON.stringify(data), data.measuredAt, now).run();
}

async function acquireRefreshLock(db) {
  const now = new Date().toISOString();
  const expiredBefore = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  const result = await db.prepare(
    "UPDATE energy_snapshot SET refresh_started_at = ? WHERE key = ? AND (refresh_started_at IS NULL OR refresh_started_at < ?)",
  ).bind(now, SNAPSHOT_KEY, expiredBefore).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function clearRefreshLock(db) {
  await db.prepare("UPDATE energy_snapshot SET refresh_started_at = NULL WHERE key = ?").bind(SNAPSHOT_KEY).run();
}

async function persistSnapshot(db, data) {
  await db.prepare(
    "UPDATE energy_snapshot SET payload = ?, measured_at = ?, updated_at = ?, refresh_started_at = NULL WHERE key = ?",
  ).bind(JSON.stringify(data), data.measuredAt, new Date().toISOString(), SNAPSHOT_KEY).run();
}

async function refreshStored(env, previousSnapshot) {
  if (activeRefresh) return activeRefresh;
  activeRefresh = (async () => {
    const acquired = await acquireRefreshLock(env.DB);
    if (!acquired) return null;
    try {
      const fresh = await refreshEnergySnapshot(env, previousSnapshot);
      await persistSnapshot(env.DB, fresh);
      return fresh;
    } catch (error) {
      await clearRefreshLock(env.DB);
      throw error;
    }
  })().finally(() => {
    activeRefresh = null;
  });
  return activeRefresh;
}

async function readValidatedStored(request, env) {
  await ensureSchema(env.DB);
  let stored = await readStored(env.DB);
  let delivery = "stored";
  if (!stored) {
    const seed = await readSeed(request, env);
    await seedStored(env.DB, seed);
    stored = await readStored(env.DB);
  }

  // A deployment can retain a fresh D1 payload written by the previous worker
  // schema. Replace it with the validated bundled snapshot before attempting a
  // network refresh so the client never receives a structurally incomplete
  // history while MAVIR is slow or another request holds the refresh lock.
  if (!hasHistoricalMix(stored.data)) {
    const seed = await readSeed(request, env);
    if (!hasHistoricalMix(seed)) throw new Error("Bundled snapshot is missing historical generation mix");
    await persistSnapshot(env.DB, seed);
    stored = {
      data: seed,
      measuredAt: seed.measuredAt,
      updatedAt: new Date().toISOString(),
      refreshStartedAt: null,
    };
  }

  // A deployment may contain a newer validated snapshot than the retained D1
  // row. Prefer that exact published snapshot before attempting an outbound
  // refresh, which also recovers cleanly when a Sites background task stalls.
  if (Date.now() - Date.parse(stored.data.measuredAt) > REFRESH_AFTER_MS) {
    try {
      const seed = await readSeed(request, env);
      if (hasHistoricalMix(seed) && Date.parse(seed.measuredAt) > Date.parse(stored.data.measuredAt)) {
        const updatedAt = new Date().toISOString();
        await persistSnapshot(env.DB, seed);
        stored = {
          data: seed,
          measuredAt: seed.measuredAt,
          updatedAt,
          refreshStartedAt: null,
        };
        delivery = "bundled-newer";
      }
    } catch {
      // A valid stored snapshot remains the safe fallback when the asset read fails.
    }
  }

  return { stored, delivery };
}

async function energyApi(request, env, ctx) {
  const { stored, delivery } = await readValidatedStored(request, env);
  const ageMs = Date.now() - Date.parse(stored.data.measuredAt);
  if (ageMs > REFRESH_AFTER_MS) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(refreshStored(env, stored.data).catch(() => null));
      return jsonResponse(stored.data, 200, {
        "x-energy-delivery": "validated-fallback-refresh-in-progress",
      });
    }
    try {
      const fresh = await refreshStored(env, stored.data);
      if (fresh) return jsonResponse(fresh, 200, { "x-energy-delivery": "refreshed" });
      return jsonResponse(stored.data, 200, {
        "x-energy-delivery": "validated-fallback-refresh-in-progress",
      });
    } catch (error) {
      return jsonResponse(stored.data, 200, {
        "x-energy-delivery": "validated-fallback",
        "x-energy-refresh-error": error.message.slice(0, 180),
      });
    }
  }

  return jsonResponse(stored.data, 200, { "x-energy-delivery": delivery });
}

async function refreshApi(request, env) {
  const { stored } = await readValidatedStored(request, env);
  const ageMs = Date.now() - Date.parse(stored.data.measuredAt);
  const ageMinutes = Math.max(0, Math.round(ageMs / 60_000));
  if (ageMs <= REFRESH_AFTER_MS) {
    return jsonResponse({
      status: "fresh",
      measuredAt: stored.data.measuredAt,
      ageMinutes,
      checks: `${stored.data.quality?.checksPassed}/${stored.data.quality?.checksTotal}`,
    });
  }

  try {
    const fresh = await refreshStored(env, stored.data);
    if (fresh) {
      return jsonResponse({
        status: "refreshed",
        measuredAt: fresh.measuredAt,
        ageMinutes: Math.max(0, Math.round((Date.now() - Date.parse(fresh.measuredAt)) / 60_000)),
        checks: `${fresh.quality?.checksPassed}/${fresh.quality?.checksTotal}`,
      });
    }

    const latest = await readStored(env.DB);
    return jsonResponse({
      status: "busy",
      measuredAt: latest?.data?.measuredAt ?? stored.data.measuredAt,
      ageMinutes: Math.max(0, Math.round((Date.now() - Date.parse(latest?.data?.measuredAt ?? stored.data.measuredAt)) / 60_000)),
      checks: `${latest?.data?.quality?.checksPassed ?? stored.data.quality?.checksPassed}/${latest?.data?.quality?.checksTotal ?? stored.data.quality?.checksTotal}`,
    }, 202, { "retry-after": "15" });
  } catch (error) {
    return jsonResponse({
      status: "error",
      measuredAt: stored.data.measuredAt,
      ageMinutes,
      error: error.message.slice(0, 180),
    }, 503);
  }
}

async function healthApi(env) {
  await ensureSchema(env.DB);
  const stored = await readStored(env.DB);
  if (!stored) return jsonResponse({ status: "initializing" }, 503);
  const ageMinutes = Math.max(0, Math.round((Date.now() - Date.parse(stored.data.measuredAt)) / 60_000));
  return jsonResponse({
    status: ageMinutes > STALE_AFTER_MS / 60_000 ? "stale" : "ok",
    measuredAt: stored.data.measuredAt,
    updatedAt: stored.updatedAt,
    ageMinutes,
    refreshing: Boolean(stored.refreshStartedAt),
    checks: `${stored.data.quality?.checksPassed}/${stored.data.quality?.checksTotal}`,
  });
}

async function withRuntimeMetadata(response, request) {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const origin = new URL(request.url).origin;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response((await response.text()).replaceAll(GITHUB_PAGES_ORIGIN, origin), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/refresh") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, { allow: "POST" });
      if (!await hasValidRefreshToken(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
      }
      return refreshApi(request, env);
    }
    if (url.pathname === "/api/energy") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { allow: "GET" });
      return energyApi(request, env, ctx);
    }
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { allow: "GET" });
      return healthApi(env);
    }

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return withRuntimeMetadata(response, request);
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return withRuntimeMetadata(await env.ASSETS.fetch(new Request(indexUrl, request)), request);
  },

  async scheduled(_controller, env, ctx) {
    await ensureSchema(env.DB);
    const stored = await readStored(env.DB);
    if (!stored || !hasHistoricalMix(stored.data)) return;
    if (Date.now() - Date.parse(stored.data.measuredAt) <= REFRESH_AFTER_MS) return;
    ctx.waitUntil(refreshStored(env, stored.data).catch((error) => {
      console.error("Scheduled energy refresh failed", error);
    }));
  },
};
