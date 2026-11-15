import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

const REFRESH_TOKEN = "test-refresh-token";

function refreshRequest(url = "https://example.test/api/refresh", token = REFRESH_TOKEN) {
  return new Request(url, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function createMockDb(snapshot, refreshLockActive = false, updatedAt = new Date().toISOString()) {
  let row = snapshot ? {
    payload: JSON.stringify(snapshot),
    measuredAt: snapshot.measuredAt,
    updatedAt,
    refreshStartedAt: null,
  } : null;

  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async first() {
          if (sql.includes("FROM energy_snapshot")) return row;
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT OR IGNORE") && !row) {
            row = { payload: values[1], measuredAt: values[2], updatedAt: values[3], refreshStartedAt: null };
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE energy_snapshot SET refresh_started_at = ?")) {
            if (refreshLockActive) return { meta: { changes: 0 } };
            row.refreshStartedAt = values[0];
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE energy_snapshot SET payload")) {
            row = { payload: values[0], measuredAt: values[1], updatedAt: values[2], refreshStartedAt: null };
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE energy_snapshot SET refresh_started_at = NULL") && row) {
            row.refreshStartedAt = null;
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("rewrites social metadata to the deployed Sites origin", async () => {
  const response = await worker.fetch(new Request("https://energy.example.test/", {
    headers: { accept: "text/html" },
  }), {
    ASSETS: {
      fetch: async () => new Response(
        '<meta property="og:image" content="https://tothur.github.io/Energy-Dashboard/og.png">',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    },
  });

  assert.match(await response.text(), /https:\/\/energy\.example\.test\/og\.png/);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("serves a fresh validated snapshot from the Sites data store", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  const snapshot = { ...bundled, generatedAt: now, measuredAt: now };
  const response = await worker.fetch(new Request("https://example.test/api/energy?v=1"), {
    DB: createMockDb(snapshot),
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  }, { waitUntil: () => assert.fail("a fresh snapshot must not trigger a refresh") });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-energy-delivery"), "stored");
  assert.equal((await response.json()).schemaVersion, 5);
});

test("a visitor does not compete with Cloudflare while data is below the recovery threshold", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const measuredAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const refreshedAt = new Date(Date.now() - 7 * 60_000).toISOString();
  const snapshot = { ...bundled, generatedAt: refreshedAt, measuredAt };
  const bundledFallback = {
    ...bundled,
    generatedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    measuredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  };
  const response = await worker.fetch(new Request("https://example.test/api/energy?v=cloudflare-primary"), {
    DB: createMockDb(snapshot, false, refreshedAt),
    ASSETS: { fetch: async () => new Response(JSON.stringify(bundledFallback), { headers: { "content-type": "application/json" } }) },
  }, { waitUntil: () => assert.fail("a visitor must not refresh data before the ten-minute recovery threshold") });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-energy-delivery"), "stored");
  assert.equal((await response.json()).measuredAt, measuredAt);
});

test("serves stale validated data immediately while refreshing in the background", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const measuredAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const staleRefreshAt = new Date(Date.now() - 11 * 60_000).toISOString();
  const snapshot = { ...bundled, generatedAt: staleRefreshAt, measuredAt };
  let backgroundRefresh;
  const response = await worker.fetch(new Request("https://example.test/api/energy?v=background"), {
    DB: createMockDb(snapshot, true, staleRefreshAt),
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  }, { waitUntil: (promise) => { backgroundRefresh = promise; } });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-energy-delivery"), "validated-fallback-refresh-in-progress");
  assert.equal((await response.json()).schemaVersion, 5);
  assert.ok(backgroundRefresh instanceof Promise);
  assert.equal(await backgroundRefresh, null);
});

test("the scheduled refresh endpoint is POST-only and lock-aware", async () => {
  const rejected = await worker.fetch(new Request("https://example.test/api/refresh"), {});
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "POST");

  const unauthorized = await worker.fetch(refreshRequest(undefined, "wrong-token"), {
    SITES_REFRESH_TOKEN: REFRESH_TOKEN,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const staleAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const stale = { ...bundled, generatedAt: staleAt, measuredAt: staleAt };
  const response = await worker.fetch(refreshRequest(), {
    DB: createMockDb(stale, true, staleAt),
    ASSETS: { fetch: async () => new Response(JSON.stringify(stale), { headers: { "content-type": "application/json" } }) },
    SITES_REFRESH_TOKEN: REFRESH_TOKEN,
  });
  const data = await response.json();

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("retry-after"), "15");
  assert.equal(data.status, "busy");
  assert.equal(data.checks, `${bundled.quality.checksPassed}/${bundled.quality.checksTotal}`);
});

test("the scheduled refresh endpoint skips upstream work for a fresh snapshot", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  const measuredAt = new Date(Date.now() - 16 * 60_000).toISOString();
  const fresh = { ...bundled, generatedAt: now, measuredAt };
  const response = await worker.fetch(refreshRequest(), {
    DB: createMockDb(fresh),
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    SITES_REFRESH_TOKEN: REFRESH_TOKEN,
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.status, "fresh");
  assert.equal(data.measuredAt, measuredAt);
  assert.ok(data.ageMinutes >= 15);
  assert.equal(data.refreshAgeMinutes, 0);
});

test("promotes a newer validated bundled snapshot over stale retained data", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  const seed = { ...bundled, generatedAt: now, measuredAt: now };
  const staleAt = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
  const stale = { ...seed, generatedAt: staleAt, measuredAt: staleAt };
  const response = await worker.fetch(new Request("https://example.test/api/energy?v=bundled-newer"), {
    DB: createMockDb(stale),
    ASSETS: { fetch: async () => new Response(JSON.stringify(seed), { headers: { "content-type": "application/json" } }) },
  }, { waitUntil: () => assert.fail("the newer bundled snapshot must avoid a background refresh") });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-energy-delivery"), "bundled-newer");
  assert.equal(data.measuredAt, seed.measuredAt);
  assert.equal(data.quality.checksPassed, data.quality.checksTotal);
});

test("replaces an incompatible stored history before serving it", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  const seed = {
    ...bundled,
    generatedAt: now,
    measuredAt: now,
    history24h: bundled.history24h.map((point, index) => ({
      ...point,
      time: new Date(Date.parse(now) - (bundled.history24h.length - 1 - index) * 15 * 60_000).toISOString(),
    })),
  };
  const incompatible = structuredClone(seed);
  incompatible.history24h.forEach((point) => {
    delete point.nuclearMW;
    delete point.solarMW;
    delete point.fossilMW;
    delete point.renewableMW;
    delete point.otherMW;
  });

  const response = await worker.fetch(new Request("https://example.test/api/energy?v=2"), {
    DB: createMockDb(incompatible),
    ASSETS: { fetch: async () => new Response(JSON.stringify(seed), { headers: { "content-type": "application/json" } }) },
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-energy-delivery"), "stored");
  assert.ok(data.history24h.every((point) => Number.isFinite(point.nuclearMW)));
});

test("replaces a retained pre-contract solar snapshot before serving it", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const incompatible = structuredClone(bundled);
  delete incompatible.source.measurements.distributedSolarAt;
  delete incompatible.quality.solarCompletenessStatus;

  const response = await worker.fetch(new Request("https://example.test/api/energy?v=solar-contract"), {
    DB: createMockDb(incompatible),
    ASSETS: { fetch: async () => new Response(JSON.stringify(bundled), { headers: { "content-type": "application/json" } }) },
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-energy-delivery"), "stored-upgraded");
  assert.equal(data.measuredAt, incompatible.measuredAt);
  assert.equal(data.source.measurements.distributedSolarAt, data.measuredAt);
  assert.equal(data.quality.solarCompletenessStatus, "passed");
});

test("reports stored snapshot health without exposing the full dataset", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const now = new Date().toISOString();
  const snapshot = { ...bundled, generatedAt: now, measuredAt: now };
  const response = await worker.fetch(new Request("https://example.test/api/health"), {
    DB: createMockDb(snapshot),
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const health = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.status, "ok");
  assert.equal(health.refreshAgeMinutes, 0);
  assert.equal(health.checks, `${bundled.quality.checksPassed}/${bundled.quality.checksTotal}`);
  assert.equal("system" in health, false);
});

test("health accepts a coherent source interval that lags a recent successful refresh", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const measuredAt = new Date(Date.now() - 16 * 60_000).toISOString();
  const refreshedAt = new Date().toISOString();
  const snapshot = { ...bundled, generatedAt: refreshedAt, measuredAt };
  const response = await worker.fetch(new Request("https://example.test/api/health"), {
    DB: createMockDb(snapshot, false, refreshedAt),
  });
  const health = await response.json();

  assert.equal(health.status, "ok");
  assert.ok(health.ageMinutes >= 15);
  assert.equal(health.refreshAgeMinutes, 0);
});

test("health reports a stale status when the last measurement is too old", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const staleAt = new Date(Date.now() - 35 * 60_000).toISOString();
  const stale = { ...bundled, generatedAt: staleAt, measuredAt: staleAt };
  const response = await worker.fetch(new Request("https://example.test/api/health"), {
    DB: createMockDb(stale),
  });
  const health = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.status, "stale");
  assert.ok(health.ageMinutes >= 34);
});

test("the worker exposes a Cloudflare scheduled-event refresh handler", async () => {
  const bundled = JSON.parse(await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"));
  const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const stale = { ...bundled, generatedAt: staleAt, measuredAt: staleAt };
  let scheduledRefresh;

  await worker.scheduled({}, { DB: createMockDb(stale, true, staleAt) }, {
    waitUntil: (promise) => { scheduledRefresh = promise; },
  });

  assert.ok(scheduledRefresh instanceof Promise);
  assert.equal(await scheduledRefresh, null);
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0000_energy_snapshot.sql", import.meta.url));
});
