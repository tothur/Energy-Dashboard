const FLOW_COUNTRIES = {
  AT: "Ausztria",
  SK: "Szlovákia",
  UA: "Ukrajna",
  RO: "Románia",
  RS: "Szerbia",
  HR: "Horvátország",
  SI: "Szlovénia",
};

const FLOW_COLUMNS = [
  ["AT", "F"],
  ["SK", "C"],
  ["UA", "B"],
  ["RO", "H"],
  ["RS", "E"],
  ["HR", "G"],
  ["SI", "D"],
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(value, label) {
  invariant(Number.isFinite(value), `${label} must be a finite number`);
  return value;
}

function rounded(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseMavirTimestamp(value) {
  invariant(typeof value === "string", "MAVIR timestamp is missing");
  const match = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/.exec(value);
  invariant(match, `Invalid MAVIR timestamp: ${value}`);
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zoneHour}:${zoneMinute}`).toISOString();
}

function hasFiniteColumns(row, columns) {
  return columns.every((column) => Number.isFinite(row[column]));
}

function lastComplete(rows, columns, label) {
  const row = rows.slice(1).findLast((candidate) => hasFiniteColumns(candidate, columns) && typeof candidate.A === "string");
  invariant(row, `No complete MAVIR ${label} row found`);
  return row;
}

function mixFromRow(row) {
  const values = [
    { key: "Atom", mw: row.H },
    { key: "Nap", mw: row.T + row.U + row.V },
    { key: "Fosszilis", mw: row.I + row.J + row.K + row.L },
    { key: "Egyéb megújuló", mw: row.M + row.N + row.O + row.P + row.Q + row.R },
    { key: "Egyéb", mw: row.S },
  ];
  const total = values.reduce((sum, item) => sum + item.mw, 0);
  return values.map((item) => ({
    key: item.key,
    mw: rounded(item.mw, 1),
    share: rounded((item.mw / total) * 100, 1),
  }));
}

export function normalizeMavirTables({ systemRows, flowRows, frequencyRows, generatedAt = new Date().toISOString() }) {
  const systemColumns = ["B", "D", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W"];
  const systemRow = lastComplete(systemRows, systemColumns, "system");
  const flowRow = lastComplete(flowRows, FLOW_COLUMNS.map(([, column]) => column), "flow");
  const frequencyRow = lastComplete(frequencyRows, ["B"], "frequency");

  const measuredAt = parseMavirTimestamp(systemRow.A);
  const flowMeasuredAt = parseMavirTimestamp(flowRow.A);
  const frequencyMeasuredAt = parseMavirTimestamp(frequencyRow.A);
  const alignmentMinutes = Math.max(
    Math.abs(Date.parse(flowMeasuredAt) - Date.parse(measuredAt)),
    Math.abs(Date.parse(frequencyMeasuredAt) - Date.parse(measuredAt)),
  ) / 60_000;
  invariant(alignmentMinutes <= 20, `MAVIR feeds are not time-aligned (${alignmentMinutes.toFixed(1)} minutes)`);

  const consumptionMW = finite(systemRow.B, "system load");
  const generationMW = finite(systemRow.D, "domestic generation");
  const netImportMW = finite(systemRow.W, "net import");
  const mix = mixFromRow(systemRow);
  const mixTotalMW = mix.reduce((sum, item) => sum + item.mw, 0);
  const flows = FLOW_COLUMNS.map(([code, column]) => {
    const mw = rounded(finite(flowRow[column], `flow ${code}`));
    return { code, country: FLOW_COUNTRIES[code], mw, direction: mw >= 0 ? "import" : "export" };
  });
  const flowTotalMW = flows.reduce((sum, flow) => sum + flow.mw, 0);
  const systemGapMW = consumptionMW - generationMW - netImportMW;
  const mixGapMW = mixTotalMW - generationMW;
  const flowGapMW = flowTotalMW - netImportMW;

  invariant(Math.abs(systemGapMW) <= Math.max(120, consumptionMW * 0.025), `System balance does not reconcile (${systemGapMW.toFixed(1)} MW gap)`);
  const allowedMixGapMW = Math.max(5, generationMW * 0.0025);
  invariant(Math.abs(mixGapMW) <= allowedMixGapMW, `Generation mix does not reconcile (${mixGapMW.toFixed(1)} MW gap)`);
  const allowedFlowGapMW = Math.max(75, consumptionMW * 0.015);
  invariant(Math.abs(flowGapMW) <= allowedFlowGapMW, `Cross-border flows do not reconcile (${flowGapMW.toFixed(1)} MW gap)`);

  const history24h = systemRows.slice(1)
    .filter((row) => hasFiniteColumns(row, ["B", "D", "W"]) && typeof row.A === "string")
    .map((row) => ({
      time: parseMavirTimestamp(row.A),
      loadMW: rounded(row.B),
      generationMW: rounded(row.D),
      importMW: rounded(row.W),
    }))
    .filter((point) => Date.parse(point.time) >= Date.parse(measuredAt) - 24 * 60 * 60_000 && Date.parse(point.time) <= Date.parse(measuredAt));
  invariant(history24h.length >= 90, `24-hour MAVIR history is incomplete (${history24h.length} points)`);

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    measuredAt,
    status: "verified_snapshot",
    source: {
      primary: "MAVIR RTDW",
      systemUrl: "https://www.mavir.hu/web/mavir/rendszerterheles",
      exportBaseUrl: "https://rtdwweb.mavir.hu/rtdwweb/webuser/chart",
      charts: { systemAndMix: 20001, crossBorderFlows: 5229, frequency: 4444 },
      price: "HUPX",
      priceStatus: "unavailable_without_licensed_direct_feed",
      measurements: { systemAt: measuredAt, flowsAt: flowMeasuredAt, frequencyAt: frequencyMeasuredAt },
      caveat: "Minden közzétett rendszeradat közvetlenül a MAVIR nyilvános RTDW-exportjából származik.",
    },
    system: {
      frequencyHz: rounded(frequencyRow.B, 3),
      consumptionMW: rounded(consumptionMW),
      generationMW: rounded(generationMW),
      netImportMW: rounded(netImportMW),
      domesticCoveragePct: rounded((generationMW / consumptionMW) * 100, 1),
      dayAheadPriceEurMWh: null,
      carbonIntensityGco2Kwh: null,
      carbonIntensityStatus: "insufficient_source_detail",
    },
    mix,
    flows,
    plants: [
      { key: "paks", name: "Paks", type: "nuclear", mw: rounded(systemRow.H), x: 46, y: 69 },
      { key: "matra", name: "Mátra", type: "fossil", mw: rounded(systemRow.I), x: 63, y: 37 },
      { key: "dunamenti", name: "Dunamenti", type: "fossil", mw: null, x: 49, y: 49 },
      { key: "gonyu", name: "Gönyű", type: "fossil", mw: null, x: 30, y: 37 },
    ],
    history24h,
    quality: {
      requiredFeeds: ["MAVIR 20001", "MAVIR 5229", "MAVIR 4444"],
      systemGapMW: rounded(systemGapMW, 1),
      flowGapMW: rounded(flowGapMW, 1),
      mixGapMW: rounded(mixGapMW, 1),
      mixToleranceMW: rounded(allowedMixGapMW, 1),
      maxFeedOffsetMinutes: rounded(alignmentMinutes, 1),
      checksPassed: 6,
      checksTotal: 6,
    },
  };
}

export function validateNormalizedEnergyData(data) {
  invariant(data?.schemaVersion === 1, "Unsupported energy data schema");
  invariant(!Number.isNaN(Date.parse(data.measuredAt)), "Invalid measurement timestamp");
  invariant(!Number.isNaN(Date.parse(data.generatedAt)), "Invalid snapshot generation timestamp");
  const measuredYear = new Date(data.measuredAt).getUTCFullYear();
  invariant(measuredYear >= 2020 && measuredYear <= 2100, "Implausible measurement timestamp");
  invariant(Date.parse(data.measuredAt) <= Date.parse(data.generatedAt) + 10 * 60_000, "Measurement timestamp is implausibly later than snapshot generation");
  invariant(data.source?.primary === "MAVIR RTDW", "Direct MAVIR attribution is missing");
  invariant(data.source?.priceStatus === "unavailable_without_licensed_direct_feed", "Price provenance status is missing");
  invariant(data.system?.dayAheadPriceEurMWh === null, "Unlicensed market price must not be published");

  const { frequencyHz, consumptionMW, generationMW, netImportMW, domesticCoveragePct } = data.system ?? {};
  [frequencyHz, consumptionMW, generationMW, netImportMW, domesticCoveragePct].forEach((value, index) => finite(value, `system metric ${index}`));
  invariant(frequencyHz >= 49 && frequencyHz <= 51, "Grid frequency is outside the plausible validation range");
  invariant(consumptionMW > 0 && consumptionMW < 20_000, "Consumption is outside the plausible validation range");
  invariant(generationMW >= 0 && generationMW < 20_000, "Generation is outside the plausible validation range");
  invariant(Math.abs(netImportMW) < 10_000, "Net import is outside the plausible validation range");
  invariant(domesticCoveragePct >= 0 && domesticCoveragePct <= 250, "Domestic coverage is outside the plausible validation range");

  const expectedMixKeys = ["Atom", "Nap", "Fosszilis", "Egyéb megújuló", "Egyéb"];
  invariant(Array.isArray(data.mix) && expectedMixKeys.every((key) => data.mix.some((item) => item.key === key)), "Generation mix categories are incomplete");
  data.mix.forEach((item) => invariant(Number.isFinite(item.mw) && item.mw >= 0, `Invalid generation mix value: ${item.key}`));
  const mixTotalMW = data.mix.reduce((sum, item) => sum + item.mw, 0);
  invariant(Math.abs(mixTotalMW - generationMW) <= Math.max(5, generationMW * 0.0025), "Published generation mix does not reconcile");

  const expectedFlowCodes = Object.keys(FLOW_COUNTRIES);
  invariant(Array.isArray(data.flows) && expectedFlowCodes.every((code) => data.flows.some((flow) => flow.code === code)), "Cross-border countries are incomplete");
  data.flows.forEach((flow) => {
    finite(flow.mw, `flow.${flow.code}.mw`);
    invariant(flow.direction === (flow.mw >= 0 ? "import" : "export"), `flow.${flow.code} direction contradicts its sign`);
  });
  const flowTotalMW = data.flows.reduce((sum, flow) => sum + flow.mw, 0);
  invariant(Math.abs(flowTotalMW - netImportMW) <= Math.max(75, consumptionMW * 0.015), "Published cross-border flows do not reconcile");

  invariant(Array.isArray(data.history24h) && data.history24h.length >= 90, "24-hour history is incomplete");
  data.history24h.forEach((point, index) => {
    invariant(!Number.isNaN(Date.parse(point.time)), `history[${index}] has an invalid timestamp`);
    finite(point.loadMW, `history[${index}].loadMW`);
    finite(point.generationMW, `history[${index}].generationMW`);
    finite(point.importMW, `history[${index}].importMW`);
    if (index > 0) invariant(Date.parse(point.time) > Date.parse(data.history24h[index - 1].time), "24-hour history is not chronological");
  });

  invariant(data.quality?.checksPassed === data.quality?.checksTotal && data.quality.checksTotal >= 6, "Not all data quality checks passed");
  const systemGapMW = consumptionMW - generationMW - netImportMW;
  invariant(Math.abs(systemGapMW - data.quality.systemGapMW) <= 1, "Declared system gap does not match the published metrics");
  invariant(Math.abs(systemGapMW) <= Math.max(120, consumptionMW * 0.025), "Published system balance does not reconcile");
  invariant(data.quality.maxFeedOffsetMinutes <= 20, "Published feeds are not time-aligned");
  return data;
}
