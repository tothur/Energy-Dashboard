import { refreshEnergySnapshot } from "./energy-service.js";

const SNAPSHOT_KEY = "latest";
const REFRESH_AFTER_MS = 2 * 60_000;
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

function hasHistoricalMix(data) {
  return Array.isArray(data?.history24h)
    && data.history24h.length > 0
    && ["nuclearMW", "solarMW", "fossilMW", "renewableMW", "otherMW"]
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

async function energyApi(request, env) {
  await ensureSchema(env.DB);
  let stored = await readStored(env.DB);
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

  const ageMs = Date.now() - Date.parse(stored.data.measuredAt);
  if (ageMs > REFRESH_AFTER_MS) {
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

  return jsonResponse(stored.data, 200, { "x-energy-delivery": "stored" });
}

async function healthApi(env) {
  await ensureSchema(env.DB);
  const stored = await readStored(env.DB);
  if (!stored) return jsonResponse({ status: "initializing" }, 503);
  return jsonResponse({
    status: "ok",
    measuredAt: stored.data.measuredAt,
    updatedAt: stored.updatedAt,
    ageMinutes: Math.max(0, Math.round((Date.now() - Date.parse(stored.data.measuredAt)) / 60_000)),
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/energy") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, { allow: "GET" });
      return energyApi(request, env);
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
};
