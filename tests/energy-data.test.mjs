import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { systemSolarComponentsAreCoherent, validateNormalizedEnergyData } from "../src/data/energy-schema.mjs";

const data = JSON.parse(
  await readFile(new URL("../public/data/energy-latest.json", import.meta.url), "utf8"),
);

test("the published snapshot passes every declared quality check", () => {
  assert.doesNotThrow(() => validateNormalizedEnergyData(data));
  assert.equal(data.schemaVersion, 5);
  assert.equal(data.quality.checksPassed, data.quality.checksTotal);
  assert.ok(new Date(data.measuredAt).getUTCFullYear() >= 2020);
  assert.ok(new Date(data.measuredAt).getUTCFullYear() <= 2100);
  assert.ok(Date.parse(data.generatedAt) - Date.parse(data.measuredAt) <= 90 * 60_000);
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

test("MAVIR plant generation and estimated distributed solar definitions stay explicit", () => {
  assert.ok(Math.abs(data.system.estimatedDistributedSolarMW - data.system.scteSolarMW - data.system.householdSolarMW) <= 1);
  assert.ok(Math.abs(data.system.generationMW - data.system.plantGenerationMW - data.system.estimatedDistributedSolarMW - data.system.generationDefinitionCorrectionMW) <= 0.2);
  const solar = data.mix.find((item) => item.key === "Nap");
  assert.ok(Math.abs(solar.mw - data.system.industrialSolarMW - data.system.estimatedDistributedSolarMW) <= 1);
  assert.ok(Number.isFinite(data.quality.generationDefinitionGapMW));
  assert.ok(Math.abs(data.quality.generationDefinitionGapMW) <= 5);
});

test("partial daytime solar rows cannot masquerade as complete measurements", () => {
  assert.equal(systemSolarComponentsAreCoherent({ T: 3857, U: 0, V: 0 }), false);
  assert.equal(systemSolarComponentsAreCoherent({ T: 3857, U: 644, V: 1803 }), true);
  assert.equal(systemSolarComponentsAreCoherent({ T: 12, U: 0, V: 0 }), true);

  const partialDaytimeSnapshot = structuredClone(data);
  partialDaytimeSnapshot.system.industrialSolarMW = 3857;
  partialDaytimeSnapshot.system.scteSolarMW = 0;
  partialDaytimeSnapshot.system.householdSolarMW = 0;
  partialDaytimeSnapshot.system.estimatedDistributedSolarMW = 0;
  assert.throws(
    () => validateNormalizedEnergyData(partialDaytimeSnapshot),
    /Distributed PV components are missing/i,
  );
});

test("a coherent pre-contract snapshot remains displayable during a rolling deployment", () => {
  const legacySnapshot = structuredClone(data);
  delete legacySnapshot.source.measurements.distributedSolarAt;
  delete legacySnapshot.quality.solarCompletenessStatus;

  assert.doesNotThrow(() => validateNormalizedEnergyData(legacySnapshot));

  const explicitlyMisaligned = structuredClone(data);
  explicitlyMisaligned.source.measurements.distributedSolarAt = new Date(
    Date.parse(data.measuredAt) - 15 * 60_000,
  ).toISOString();
  assert.throws(
    () => validateNormalizedEnergyData(explicitlyMisaligned),
    /Distributed PV measurement timestamp is not aligned/i,
  );
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

test("every historical point retains a reconciled MAVIR generation mix", () => {
  const mixKeys = ["nuclearMW", "solarMW", "fossilMW", "renewableMW", "otherMW"];
  data.history24h.forEach((point) => {
    mixKeys.forEach((key) => assert.ok(Number.isFinite(point[key]), `${key} is missing at ${point.time}`));
    const total = mixKeys.reduce((sum, key) => sum + point[key], 0);
    assert.ok(Math.abs(total - point.generationMW) <= Math.max(5, point.generationMW * 0.0025));
    assert.ok(Math.abs(point.estimatedDistributedSolarMW - point.scteSolarMW - point.householdSolarMW) <= 1);
    assert.ok(Math.abs(point.generationMW - point.plantGenerationMW - point.estimatedDistributedSolarMW - point.generationDefinitionCorrectionMW) <= 0.2);
  });
});

test("MAVIR planned and actual gross load remain aligned and reconciled", () => {
  assert.equal(data.source.charts.loadPlanActual, 7678);
  assert.ok(data.quality.requiredFeeds.includes("MAVIR 7678"));
  assert.equal(data.loadHistory24h.length, data.quality.loadPlanCoveragePoints);
  assert.ok(data.loadHistory24h.length >= 90);
  data.loadHistory24h.forEach((point, index) => {
    assert.ok(Number.isFinite(point.actualMW));
    assert.ok(Number.isFinite(point.plannedMW));
    assert.ok(Math.abs(point.deviationMW - (point.actualMW - point.plannedMW)) <= 0.2);
    if (index > 0) assert.ok(Date.parse(point.time) > Date.parse(data.loadHistory24h[index - 1].time));
  });
  assert.ok(data.quality.loadPlanLatestOffsetMinutes <= 20);
});

test("plant markers state the limits of their live status", () => {
  const paks = data.plants.find((plant) => plant.key === "paks");
  const gonyu = data.plants.find((plant) => plant.key === "gonyu");
  assert.equal(paks.liveCoverage, "block_level");
  assert.match(paks.liveMetric, /OAH/);
  assert.ok(Number.isFinite(paks.capacityMW));
  assert.equal(paks.blocks.length, 4);
  assert.equal(paks.blocks.reduce((sum, block) => sum + block.mw, 0), paks.mw);
  assert.equal(paks.operationalDataStatus, "available");
  assert.ok(Number.isFinite(data.quality.paksVsMavirGapMW));
  assert.equal(gonyu.liveCoverage, "unavailable");
  assert.match(gonyu.statusNote, /nem állapítható meg/);
  assert.match(gonyu.sourceUrl, /^https:\/\//);
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

  const badDefinition = structuredClone(data);
  badDefinition.system.householdSolarMW += 100;
  assert.throws(() => validateNormalizedEnergyData(badDefinition), /Distributed PV components do not reconcile/i);

  const badLoadPlan = structuredClone(data);
  badLoadPlan.loadHistory24h[0].deviationMW += 100;
  assert.throws(() => validateNormalizedEnergyData(badLoadPlan), /deviation does not reconcile/i);
});
