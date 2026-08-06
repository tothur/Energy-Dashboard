import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

function createMockDb(snapshot) {
  let row = snapshot ? {
    payload: JSON.stringify(snapshot),
    measuredAt: snapshot.measuredAt,
    updatedAt: new Date().toISOString(),
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
  assert.equal((await response.json()).schemaVersion, 3);
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
  assert.equal(health.checks, "10/10");
  assert.equal("system" in health, false);
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0000_energy_snapshot.sql", import.meta.url));
});
