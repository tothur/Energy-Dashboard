import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
  "utf8",
);

test("Pages publication refreshes and validates data before deployment", () => {
  const refresh = workflow.indexOf("run: npm run data:update");
  const verify = workflow.indexOf("run: node --test tests/energy-data.test.mjs");
  const build = workflow.indexOf("run: npm run build");
  const upload = workflow.indexOf("uses: actions/upload-pages-artifact@v3");

  assert.ok(refresh > -1, "workflow must refresh energy data");
  assert.ok(verify > refresh, "data verification must follow refresh");
  assert.ok(build > verify, "build must follow data verification");
  assert.ok(upload > build, "only a successfully built site may be uploaded");
});

test("Pages publication supports main pushes, manual runs, and frequent refreshes", () => {
  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /path: \.\/dist\/client/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});
