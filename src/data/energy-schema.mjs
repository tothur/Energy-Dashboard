const REQUIRED_FEEDS = ["load", "flows", "mix", "nuclear", "freq", "price"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(value, label) {
  invariant(Number.isFinite(value), `${label} must be a finite number`);
  return value;
}

function isoFromEpochSeconds(value, label) {
  finite(value, label);
  return new Date(value * 1000).toISOString();
}

function epochToMs(value, label) {
  finite(value, label);
  return value > 10_000_000_000 ? value : value * 1000;
}

function rounded(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function latestTimestamp(raw) {
  const candidates = [
    raw?.load?.lastT ? epochToMs(raw.load.lastT, "load timestamp") : null,
    raw?.flowsT ? epochToMs(raw.flowsT, "flow timestamp") : null,
    raw?.mix?.t ? epochToMs(raw.mix.t, "mix timestamp") : null,
    raw?.price?.at ? epochToMs(raw.price.at, "price timestamp") : null,
  ].filter(Number.isFinite);
  invariant(candidates.length > 0, "No upstream measurement timestamp found");
  return new Date(Math.max(...candidates)).toISOString();
}

function validateUpstream(raw) {
  invariant(raw && typeof raw === "object", "Upstream payload is not an object");
  invariant(Array.isArray(raw.errors), "Upstream payload has no error list");
  invariant(raw.errors.length === 0, `Upstream reported errors: ${raw.errors.join(", ")}`);
  for (const feed of REQUIRED_FEEDS) {
    invariant(raw.ok?.[feed] === true, `Required upstream feed is not healthy: ${feed}`);
  }
  invariant(!Number.isNaN(Date.parse(raw.generatedAt)), "Invalid upstream generation timestamp");
}

function normalizeMix(raw) {
  const upstreamGroups = raw.mix.groups.map((group) => ({
    key: group.k,
    mw: rounded(finite(group.mw, `mix.${group.k}.mw`), 1),
    share: rounded(finite(group.pct, `mix.${group.k}.pct`), 1),
  }));

  const solarMw = rounded(finite(raw.solar.mw, "solar.mw"), 1);
  const groups = [
    upstreamGroups.find((group) => group.key === "Atom"),
    { key: "Nap", mw: solarMw, share: rounded((solarMw / raw.mix.total) * 100, 1) },
    upstreamGroups.find((group) => group.key === "Fosszilis"),
    upstreamGroups.find((group) => group.key === "Egyéb megújuló"),
    upstreamGroups.find((group) => group.key === "Egyéb"),
  ].filter(Boolean);

  const totalFromGroups = groups.reduce((sum, group) => sum + group.mw, 0);
  const reportedTotal = finite(raw.mix.total, "mix.total");
  const mixGap = Math.abs(totalFromGroups - reportedTotal);
  invariant(mixGap <= Math.max(2, reportedTotal * 0.005), `Generation mix does not reconcile (${mixGap.toFixed(1)} MW gap)`);

  return { groups, totalMW: rounded(totalFromGroups, 1) };
}

function normalizeHistory(raw) {
  const { t, load, imp, groups } = raw.dayShape;
  invariant([t, load, imp].every(Array.isArray), "24-hour history arrays are missing");
  invariant(t.length === load.length && load.length === imp.length, "24-hour history arrays have different lengths");
  invariant(t.length >= 24, "24-hour history is incomplete");

  const domesticByIndex = t.map((_, index) =>
    groups.reduce((sum, group) => sum + finite(group.mw[index], `history.${group.k}[${index}]`), 0),
  );

  return t.map((timestamp, index) => ({
    time: isoFromEpochSeconds(timestamp, `history.time[${index}]`),
    loadMW: rounded(finite(load[index], `history.load[${index}]`)),
    generationMW: rounded(domesticByIndex[index]),
    importMW: rounded(finite(imp[index], `history.import[${index}]`)),
  }));
}

export function normalizeEnergyPayload(raw) {
  validateUpstream(raw);
  const mix = normalizeMix(raw);
  const consumptionMW = finite(raw.consumption, "consumption");
  const netImportMW = finite(raw.balance, "balance");
  const reconciliationGapMW = consumptionMW - mix.totalMW - netImportMW;
  const flowSumMW = raw.flows.reduce((sum, flow) => sum + finite(flow.mw, `flow.${flow.c}`), 0);
  const allowedGapMW = Math.max(120, consumptionMW * 0.025);

  invariant(
    Math.abs(reconciliationGapMW) <= allowedGapMW,
    `System balance does not reconcile (${reconciliationGapMW.toFixed(1)} MW gap)`,
  );
  invariant(
    Math.abs(flowSumMW - netImportMW) <= 2,
    `Cross-border flows do not reconcile (${(flowSumMW - netImportMW).toFixed(1)} MW gap)`,
  );

  const frequencyDeviation = raw.freq.mhz.at(-1);
  finite(frequencyDeviation, "frequency deviation");

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    upstreamGeneratedAt: new Date(raw.generatedAt).toISOString(),
    measuredAt: latestTimestamp(raw),
    status: "verified_snapshot",
    source: {
      primary: "MAVIR",
      price: raw.price.src === "energy-charts" ? "Energy-Charts / SMARD" : raw.price.src,
      intermediary: "holadelej.hu public data endpoint",
      sourceUrl: "https://holadelej.hu/api/data",
      caveat: "Prototype adapter. Production should ingest directly from MAVIR and licensed market feeds.",
    },
    system: {
      frequencyHz: rounded(50 + frequencyDeviation / 1000, 3),
      consumptionMW: rounded(consumptionMW),
      generationMW: rounded(mix.totalMW),
      netImportMW: rounded(netImportMW),
      domesticCoveragePct: rounded((mix.totalMW / consumptionMW) * 100, 1),
      dayAheadPriceEurMWh: rounded(finite(raw.price.eur, "price.eur"), 2),
      carbonIntensityGco2Kwh: null,
      carbonIntensityStatus: "insufficient_source_detail",
    },
    mix: mix.groups,
    flows: raw.flows.map((flow) => ({
      code: flow.c,
      country: flow.name,
      mw: rounded(flow.mw),
      direction: flow.mw >= 0 ? "import" : "export",
    })),
    plants: [
      { key: "paks", name: "Paks", type: "nuclear", mw: rounded(finite(raw.plants.paks, "plants.paks")), x: 46, y: 69 },
      { key: "matra", name: "Mátra", type: "fossil", mw: rounded(finite(raw.plants.matra, "plants.matra")), x: 63, y: 37 },
      { key: "dunamenti", name: "Dunamenti", type: "fossil", mw: null, x: 49, y: 49 },
      { key: "gonyu", name: "Gönyű", type: "fossil", mw: null, x: 30, y: 37 },
    ],
    history24h: normalizeHistory(raw),
    quality: {
      requiredFeeds: REQUIRED_FEEDS,
      systemGapMW: rounded(reconciliationGapMW, 1),
      flowGapMW: rounded(flowSumMW - netImportMW, 1),
      mixGapMW: rounded(mix.groups.reduce((sum, item) => sum + item.mw, 0) - mix.totalMW, 1),
      checksPassed: 4,
      checksTotal: 4,
    },
  };
}

export function validateNormalizedEnergyData(data) {
  invariant(data?.schemaVersion === 1, "Unsupported energy data schema");
  invariant(!Number.isNaN(Date.parse(data.measuredAt)), "Invalid measurement timestamp");
  invariant(!Number.isNaN(Date.parse(data.generatedAt)), "Invalid snapshot generation timestamp");
  const measuredYear = new Date(data.measuredAt).getUTCFullYear();
  invariant(measuredYear >= 2020 && measuredYear <= 2100, "Implausible measurement timestamp");
  invariant(
    new Date(data.measuredAt).getTime() <= new Date(data.generatedAt).getTime() + 10 * 60_000,
    "Measurement timestamp is implausibly later than snapshot generation",
  );
  invariant(data.source?.primary === "MAVIR", "Primary system-data attribution is missing");

  const { frequencyHz, consumptionMW, generationMW, netImportMW, domesticCoveragePct, dayAheadPriceEurMWh } = data.system ?? {};
  [frequencyHz, consumptionMW, generationMW, netImportMW, domesticCoveragePct, dayAheadPriceEurMWh]
    .forEach((value, index) => finite(value, `system metric ${index}`));
  invariant(frequencyHz >= 49 && frequencyHz <= 51, "Grid frequency is outside the plausible validation range");
  invariant(consumptionMW > 0 && consumptionMW < 20_000, "Consumption is outside the plausible validation range");
  invariant(generationMW >= 0 && generationMW < 20_000, "Generation is outside the plausible validation range");
  invariant(Math.abs(netImportMW) < 10_000, "Net import is outside the plausible validation range");
  invariant(domesticCoveragePct >= 0 && domesticCoveragePct <= 250, "Domestic coverage is outside the plausible validation range");

  invariant(Array.isArray(data.mix) && data.mix.length === 5, "Generation mix is incomplete");
  const expectedMixKeys = ["Atom", "Nap", "Fosszilis", "Egyéb megújuló", "Egyéb"];
  invariant(expectedMixKeys.every((key) => data.mix.some((item) => item.key === key)), "Generation mix categories are incomplete");
  data.mix.forEach((item) => {
    finite(item.mw, `mix.${item.key}.mw`);
    invariant(item.mw >= 0, `mix.${item.key}.mw cannot be negative`);
  });
  const mixTotalMW = data.mix.reduce((sum, item) => sum + item.mw, 0);
  invariant(Math.abs(mixTotalMW - generationMW) <= 1, "Published generation mix does not reconcile");

  invariant(Array.isArray(data.flows) && data.flows.length === 7, "Cross-border flow set is incomplete");
  const expectedFlowCodes = ["AT", "SK", "UA", "RO", "RS", "HR", "SI"];
  invariant(expectedFlowCodes.every((code) => data.flows.some((flow) => flow.code === code)), "Cross-border countries are incomplete");
  data.flows.forEach((flow) => {
    finite(flow.mw, `flow.${flow.code}.mw`);
    invariant(flow.direction === (flow.mw >= 0 ? "import" : "export"), `flow.${flow.code} direction contradicts its sign`);
  });
  const flowTotalMW = data.flows.reduce((sum, flow) => sum + flow.mw, 0);
  invariant(Math.abs(flowTotalMW - netImportMW) <= 2, "Published cross-border flows do not reconcile");

  invariant(Array.isArray(data.history24h) && data.history24h.length >= 24, "24-hour history is incomplete");
  data.history24h.forEach((point, index) => {
    invariant(!Number.isNaN(Date.parse(point.time)), `history[${index}] has an invalid timestamp`);
    finite(point.loadMW, `history[${index}].loadMW`);
    finite(point.generationMW, `history[${index}].generationMW`);
    finite(point.importMW, `history[${index}].importMW`);
    if (index > 0) invariant(Date.parse(point.time) > Date.parse(data.history24h[index - 1].time), "24-hour history is not chronological");
  });

  invariant(data.quality?.checksPassed === data.quality?.checksTotal, "Not all data quality checks passed");
  invariant(data.quality.checksTotal >= 4, "Required quality checks are missing");
  const systemGapMW = consumptionMW - generationMW - netImportMW;
  invariant(Math.abs(systemGapMW - data.quality.systemGapMW) <= 1, "Declared system gap does not match the published metrics");
  invariant(Math.abs(systemGapMW) <= Math.max(120, consumptionMW * 0.025), "Published system balance does not reconcile");
  return data;
}
