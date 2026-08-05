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
  assert.ok(Date.parse(data.generatedAt) - Date.parse(data.measuredAt) <= 65 * 60_000);
  assert.equal(data.source.primary, "MAVIR RTDW");
  assert.equal(data.source.price, "ENTSO-E Transparency Platform");
  assert.equal(data.source.annualEmissions, "EEA GHG Inventory");
  assert.equal(data.annualEmissions.status, "available");
  assert.equal(data.annualEmissions.latest.year, data.annualEmissions.previous.year + 1);
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
  const lowCarbonMW = data.mix.filter((item) => ["Atom", "Nap", "Egyéb megújuló"].includes(item.key)).reduce((sum, item) => sum + item.mw, 0);
  assert.ok(Math.abs(data.system.lowCarbonSharePct - (lowCarbonMW / data.system.generationMW) * 100) <= 0.2);
  data.flows.forEach((flow) => {
    assert.ok(Number.isFinite(flow.scheduledMW));
    assert.ok(Math.abs(flow.deviationMW - (flow.mw - flow.scheduledMW)) <= 1);
  });
});

test("15-minute movement reconciles to the retained MAVIR history", () => {
  const comparison = data.history24h.find((point) => point.time === data.movement15m.comparisonAt);
  assert.ok(comparison);
  assert.ok(data.movement15m.elapsedMinutes >= 10 && data.movement15m.elapsedMinutes <= 20);
  assert.ok(Math.abs(data.movement15m.consumptionMW - (data.system.consumptionMW - comparison.loadMW)) <= 0.2);
  assert.ok(Math.abs(data.movement15m.generationMW - (data.system.generationMW - comparison.generationMW)) <= 0.2);
  assert.ok(Math.abs(data.movement15m.netImportMW - (data.system.netImportMW - comparison.importMW)) <= 0.2);
  assert.ok(Math.abs(data.movement15m.domesticCoveragePct - (data.system.domesticCoveragePct - comparison.domesticCoveragePct)) <= 0.2);
  assert.ok(Math.abs(data.movement15m.lowCarbonSharePct - (data.system.lowCarbonSharePct - comparison.lowCarbonSharePct)) <= 0.2);
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
