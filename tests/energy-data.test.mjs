import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateNormalizedEnergyData } from "../src/data/energy-schema.mjs";

const data = JSON.parse(
  await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"),
);

test("the published snapshot passes every declared quality check", () => {
  assert.doesNotThrow(() => validateNormalizedEnergyData(data));
  assert.equal(data.quality.checksPassed, data.quality.checksTotal);
  assert.ok(new Date(data.measuredAt).getUTCFullYear() >= 2020);
  assert.ok(new Date(data.measuredAt).getUTCFullYear() <= 2100);
  assert.ok(Date.parse(data.generatedAt) - Date.parse(data.measuredAt) <= 35 * 60_000);
  assert.equal(data.source.primary, "MAVIR RTDW");
  assert.equal(data.system.dayAheadPriceEurMWh, null);
  assert.ok(data.quality.requiredFeeds.every((feed) => feed.startsWith("MAVIR ")));
});

test("generation, import, and consumption reconcile within the declared gap", () => {
  const gap = data.system.consumptionMW - data.system.generationMW - data.system.netImportMW;
  assert.ok(Math.abs(gap - data.quality.systemGapMW) <= 1);
  assert.ok(Math.abs(gap) <= 120);
});

test("generation shares and cross-border flows are internally consistent", () => {
  const mixTotal = data.mix.reduce((sum, item) => sum + item.mw, 0);
  const flowTotal = data.flows.reduce((sum, item) => sum + item.mw, 0);
  assert.ok(Math.abs(mixTotal - data.system.generationMW) <= Math.max(5, data.system.generationMW * 0.0025));
  assert.ok(Math.abs(flowTotal - data.system.netImportMW) <= Math.max(75, data.system.consumptionMW * 0.015));
});

test("runtime validation fails closed when published values are tampered with", () => {
  const badMix = structuredClone(data);
  badMix.mix[0].mw += 100;
  assert.throws(() => validateNormalizedEnergyData(badMix), /generation mix does not reconcile/i);

  const badFlow = structuredClone(data);
  badFlow.flows[0].direction = badFlow.flows[0].mw >= 0 ? "export" : "import";
  assert.throws(() => validateNormalizedEnergyData(badFlow), /direction contradicts/i);

  const badTimestamp = structuredClone(data);
  badTimestamp.measuredAt = "+058562-08-04T20:48:09.000Z";
  assert.throws(() => validateNormalizedEnergyData(badTimestamp), /timestamp/i);
});
