const DEFAULT_SITE_URL = "https://hungary-energy-dashboard.andrastoth.chatgpt.site";
const siteUrl = (process.env.SITES_REFRESH_URL || DEFAULT_SITE_URL).replace(/\/$/, "");
const maximumHealthAgeMinutes = Number(process.env.MAXIMUM_HEALTH_AGE_MINUTES || 10);
const pollAttempts = Number(process.env.REFRESH_POLL_ATTEMPTS || 8);
const pollIntervalMs = Number(process.env.REFRESH_POLL_INTERVAL_MS || 15_000);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(url, options = {}) {
  const response = await fetch(url, {
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

const trigger = await readJson(`${siteUrl}/api/refresh`, { method: "POST" });
if (![200, 202].includes(trigger.response.status)) {
  throw new Error(`Sites refresh failed: HTTP ${trigger.response.status} · ${trigger.body.error || trigger.body.status || "unknown error"}`);
}
if (!["fresh", "refreshed", "busy"].includes(trigger.body.status)) {
  throw new Error(`Sites refresh returned an unexpected state: ${trigger.body.status || "missing"}`);
}

for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
  const health = await readJson(`${siteUrl}/api/health?v=${Date.now()}`);
  const ready = health.response.ok
    && health.body.status === "ok"
    && health.body.refreshing === false
    && Number.isFinite(health.body.ageMinutes)
    && health.body.ageMinutes <= maximumHealthAgeMinutes
    && checksPass(health.body.checks);

  if (ready) {
    console.log(JSON.stringify({ trigger: trigger.body, health: health.body }, null, 2));
    process.exit(0);
  }
  if (attempt < pollAttempts) await delay(pollIntervalMs);
}

throw new Error(`Sites refresh did not produce a healthy snapshot within ${Math.round(pollAttempts * pollIntervalMs / 1000)} seconds`);
