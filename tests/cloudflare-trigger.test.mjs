import assert from "node:assert/strict";
import test from "node:test";
import triggerWorker, { refreshAndVerify } from "../cloudflare/refresh-trigger/index.js";

const env = {
  SITE_URL: "https://energy.example.test",
  SITES_REFRESH_TOKEN: "test-refresh-token",
  MAXIMUM_HEALTH_AGE_MINUTES: "10",
  REFRESH_POLL_ATTEMPTS: "2",
  REFRESH_POLL_INTERVAL_MS: "1",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Cloudflare cron authenticates the refresh and verifies health", async () => {
  const requests = [];
  const fetcher = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/api/refresh")) {
      return json({ status: "refreshed", measuredAt: "2026-08-10T12:00:00.000Z", ageMinutes: 0, checks: "15/15" });
    }
    return json({ status: "ok", measuredAt: "2026-08-10T12:00:00.000Z", ageMinutes: 0, refreshing: false, checks: "15/15" });
  };

  const result = await refreshAndVerify(env, { fetcher, wait: async () => {} });

  assert.equal(result.trigger.status, "refreshed");
  assert.equal(result.health.checks, "15/15");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-refresh-token");
  assert.match(requests[1].url, /\/api\/health\?v=/);
});

test("Cloudflare cron rejects an unhealthy snapshot after bounded polling", async () => {
  let healthReads = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith("/api/refresh")) return json({ status: "busy" }, 202);
    healthReads += 1;
    return json({ status: "stale", ageMinutes: 45, refreshing: false, checks: "15/15" });
  };

  await assert.rejects(
    refreshAndVerify(env, { fetcher, wait: async () => {} }),
    /did not produce a healthy snapshot within 0 seconds/,
  );
  assert.equal(healthReads, 2);
});

test("Cloudflare cron fails closed without its secret", async () => {
  await assert.rejects(refreshAndVerify({ SITE_URL: env.SITE_URL }), /SITES_REFRESH_TOKEN is required/);
});

test("the public Cloudflare Worker route does not expose a manual trigger", async () => {
  const response = await triggerWorker.fetch(new Request("https://cron.example.test/"));
  assert.equal(response.status, 404);
});
