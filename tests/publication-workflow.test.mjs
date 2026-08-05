import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
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

test("the updater uses direct MAVIR exports and no intermediary", () => {
  assert.match(updater, /rtdwweb\.mavir\.hu/);
  assert.match(updater, /fetchChart\(20001\)/);
  assert.match(updater, /fetchChart\(5229\)/);
  assert.match(updater, /fetchChart\(4444\)/);
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
