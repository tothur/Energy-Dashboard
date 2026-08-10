import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
  "utf8",
);
const sitesRefreshWorkflow = await readFile(
  new URL("../.github/workflows/refresh-sites.yml", import.meta.url),
  "utf8",
);
const sitesRefreshScript = await readFile(new URL("../scripts/trigger-sites-refresh.mjs", import.meta.url), "utf8");
const cloudflareRefreshConfig = await readFile(
  new URL("../cloudflare/refresh-trigger/wrangler.jsonc", import.meta.url),
  "utf8",
);
const cloudflareRefreshWorker = await readFile(
  new URL("../cloudflare/refresh-trigger/index.js", import.meta.url),
  "utf8",
);
const updater = await readFile(new URL("../scripts/update-energy-data.mjs", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

test("Pages publication refreshes and validates data before deployment", () => {
  const refresh = workflow.indexOf("run: npm run data:update");
  const verify = workflow.indexOf("run: node --test tests/energy-data.test.mjs");
  const build = workflow.indexOf("run: npm run build");
  const upload = workflow.indexOf("uses: actions/upload-pages-artifact@v3");

  assert.ok(refresh > -1, "workflow must refresh energy data");
  assert.ok(verify > refresh, "data verification must follow refresh");
  assert.ok(build > verify, "build must follow data verification");
  assert.ok(upload > build, "only a successfully built site may be uploaded");
  assert.doesNotMatch(workflow, /continue-on-error: true/);
  assert.doesNotMatch(workflow, /snapshot fallback/i);
});

test("Pages publication supports main pushes, manual runs, and frequent refreshes", () => {
  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /cron: "2-59\/5 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /path: \.\/dist\/client/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /ENTSOE_SECURITY_TOKEN: \$\{\{ secrets\.ENTSOE_SECURITY_TOKEN \}\}/);
});

test("GitHub retains an authenticated manual Sites refresh fallback", () => {
  assert.doesNotMatch(sitesRefreshWorkflow, /schedule:/);
  assert.match(sitesRefreshWorkflow, /workflow_dispatch:/);
  assert.match(sitesRefreshWorkflow, /node scripts\/trigger-sites-refresh\.mjs/);
  assert.match(sitesRefreshWorkflow, /cancel-in-progress: false/);
  assert.match(sitesRefreshWorkflow, /SITES_REFRESH_TOKEN: \$\{\{ secrets\.SITES_REFRESH_TOKEN \}\}/);
  assert.match(sitesRefreshScript, /\/api\/refresh/);
  assert.match(sitesRefreshScript, /authorization: `Bearer \$\{refreshToken\}`/);
  assert.match(sitesRefreshScript, /\/api\/health/);
  assert.match(sitesRefreshScript, /health\.body\.ageMinutes <= maximumHealthAgeMinutes/);
  assert.match(sitesRefreshScript, /health\.body\.refreshAgeMinutes <= maximumRefreshAgeMinutes/);
  assert.match(sitesRefreshScript, /checksPass\(health\.body\.checks\)/);
});

test("Cloudflare owns the five-minute authenticated production schedule", () => {
  assert.match(cloudflareRefreshConfig, /"crons": \["\*\/5 \* \* \* \*"\]/);
  assert.match(cloudflareRefreshConfig, /hungary-energy-dashboard\.andrastoth\.chatgpt\.site/);
  assert.match(cloudflareRefreshWorker, /SITES_REFRESH_TOKEN is required/);
  assert.match(cloudflareRefreshWorker, /authorization: `Bearer \$\{env\.SITES_REFRESH_TOKEN\}`/);
  assert.match(cloudflareRefreshWorker, /\/api\/health\?v=/);
  assert.match(cloudflareRefreshWorker, /health\.body\.refreshAgeMinutes <= maximumRefreshAgeMinutes/);
  assert.match(cloudflareRefreshWorker, /checksPass\(health\.body\.checks\)/);
});

test("the updater uses direct MAVIR exports and no intermediary", () => {
  assert.match(updater, /rtdwweb\.mavir\.hu/);
  assert.match(updater, /fetchChart\(20001\)/);
  assert.match(updater, /fetchChart\(5229\)/);
  assert.match(updater, /fetchChart\(4444\)/);
  assert.match(updater, /fetchChart\(7678\)/);
  assert.match(updater, /fetchEeaAnnualEmissions/);
  assert.match(updater, /fetchEntsoePrices/);
  assert.match(updater, /discodata\.eea\.europa\.eu|energy-enrichment/);
  assert.doesNotMatch(updater, /holadelej|energy-charts|smard/i);
  assert.doesNotMatch(updater, /Promise\.all\(\[\s*fetchChart/);
  assert.match(updater, /response\.status === 429/);
});

test("an open dashboard polls for newly published snapshots", () => {
  assert.match(app, /setInterval\(\(\) => load\(false\), 60_000\)/);
  assert.match(app, /\/api\/energy\?v=\$\{Date\.now\(\)\}/);
  assert.match(app, /v=\$\{Date\.now\(\)\}/);
  assert.match(app, /visibilitychange/);
});

test("the dashboard links to the related Climate Dashboard", () => {
  assert.match(app, /https:\/\/tothur\.github\.io\/Climate-Dashboard\//);
  assert.match(app, /aria-label="Climate Dashboard megnyitása új lapon"/);
});
