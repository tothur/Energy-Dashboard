const DEFAULT_SITE_URL = "https://hungary-energy-dashboard.andrastoth.chatgpt.site";
const DEFAULT_MAXIMUM_HEALTH_AGE_MINUTES = 30;
const DEFAULT_MAXIMUM_REFRESH_AGE_MINUTES = 10;
const DEFAULT_POLL_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url}: expected JSON, received HTTP ${response.status}`);
  }
  return { response, body };
}

function checksPass(value) {
  const match = String(value || "").match(/^(\d+)\/(\d+)$/);
  return Boolean(match && Number(match[1]) > 0 && match[1] === match[2]);
}

export async function refreshAndVerify(env, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? delay;
  const siteUrl = (env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, "");
  const maximumHealthAgeMinutes = Number(env.MAXIMUM_HEALTH_AGE_MINUTES || DEFAULT_MAXIMUM_HEALTH_AGE_MINUTES);
  const maximumRefreshAgeMinutes = Number(env.MAXIMUM_REFRESH_AGE_MINUTES || DEFAULT_MAXIMUM_REFRESH_AGE_MINUTES);
  const pollAttempts = Number(env.REFRESH_POLL_ATTEMPTS || DEFAULT_POLL_ATTEMPTS);
  const pollIntervalMs = Number(env.REFRESH_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
  if (!env.SITES_REFRESH_TOKEN) throw new Error("SITES_REFRESH_TOKEN is required");

  const trigger = await readJson(fetcher, `${siteUrl}/api/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.SITES_REFRESH_TOKEN}` },
  });
  if (![200, 202].includes(trigger.response.status)) {
    throw new Error(`Sites refresh failed: HTTP ${trigger.response.status} · ${trigger.body.error || trigger.body.status || "unknown error"}`);
  }
  if (!["fresh", "refreshed", "busy"].includes(trigger.body.status)) {
    throw new Error(`Sites refresh returned an unexpected state: ${trigger.body.status || "missing"}`);
  }

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const health = await readJson(fetcher, `${siteUrl}/api/health?v=${Date.now()}`);
    const ready = health.response.ok
      && health.body.status === "ok"
      && health.body.refreshing === false
      && Number.isFinite(health.body.ageMinutes)
      && health.body.ageMinutes <= maximumHealthAgeMinutes
      && Number.isFinite(health.body.refreshAgeMinutes)
      && health.body.refreshAgeMinutes <= maximumRefreshAgeMinutes
      && checksPass(health.body.checks);

    if (ready) return { trigger: trigger.body, health: health.body };
    if (attempt < pollAttempts) await wait(pollIntervalMs);
  }

  throw new Error(`Sites refresh did not produce a healthy snapshot within ${Math.round(pollAttempts * pollIntervalMs / 1000)} seconds`);
}

export default {
  async fetch() {
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshAndVerify(env).then((result) => {
      console.log(JSON.stringify(result));
    }));
  },
};
