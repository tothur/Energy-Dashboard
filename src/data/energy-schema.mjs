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

const FLOW_SCHEDULE_COLUMNS = {
  AT: "I",
  HR: "J",
  SI: "K",
  SK: "L",
  RS: "M",
  UA: "N",
  RO: "O",
};

const DISTRIBUTED_SOLAR_COMPLETENESS_THRESHOLD_MW = 250;
const MAX_PUBLISHABLE_SOURCE_AGE_MS = 90 * 60_000;

const PLANT_DIRECTORY = {
  paks: {
    name: "Paks",
    type: "nuclear",
    technology: "4 × VVER-440/V-213 blokk",
    operator: "MVM Paksi Atomerőmű Zrt.",
    capacityMW: 2026.6,
    liveMetric: "MAVIR · Nukleáris erőművek",
    sourceUrl: "https://atomeromu.mvm.hu/hu-HU/Tudastar/UzemidoHosszabbitas/2052-2057",
    x: 46,
    y: 69,
  },
  matra: {
    name: "Mátra",
    type: "fossil",
    technology: "Lignittüzelésű erőmű",
    operator: "MVM Mátra Energia Zrt.",
    capacityMW: null,
    liveMetric: "MAVIR · Barnakőszén–lignit erőművek",
    sourceUrl: "https://mert.mvm.hu/",
    x: 63,
    y: 37,
  },
  dunamenti: {
    name: "Dunamenti",
    type: "fossil",
    technology: "Földgáztüzelés és akkumulátoros tárolás",
    operator: "MET Group",
    capacityMW: null,
    liveMetric: null,
    sourceUrl: "https://met.com/en/media/website-magazine/60-year-old-dunamenti-power-station-transforms-into-energy-transition-cluster/",
    x: 49,
    y: 49,
  },
  gonyu: {
    name: "Gönyű",
    type: "fossil",
    technology: "Kombinált ciklusú gázturbina (CCGT)",
    operator: "Veolia Hungary",
    capacityMW: 428,
    liveMetric: null,
    sourceUrl: "https://www.veolia.hu/hu/hirek/megvasarolta-veolia-gonyui-eromuvet",
    x: 30,
    y: 37,
  },
};

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

function nearestComplete(rows, columns, targetTimestamp, label) {
  const targetMs = Date.parse(parseMavirTimestamp(targetTimestamp));
  const candidates = rows.slice(1).filter((row) => hasFiniteColumns(row, columns) && typeof row.A === "string");
  invariant(candidates.length > 0, `No complete MAVIR ${label} row found`);
  return candidates.reduce((nearest, row) => {
    const distance = Math.abs(Date.parse(parseMavirTimestamp(row.A)) - targetMs);
    const nearestDistance = Math.abs(Date.parse(parseMavirTimestamp(nearest.A)) - targetMs);
    return distance < nearestDistance ? row : nearest;
  });
}

export function systemRowIsSettled(row) {
  const distributedSolarMW = row.U + row.V;
  const plantMixMW = row.H + row.I + row.J + row.K + row.L + row.M + row.N + row.O + row.P + row.Q + row.R + row.S + row.T;
  const mixTotalMW = plantMixMW + distributedSolarMW;
  const generationToleranceMW = Math.max(5, row.D * 0.0025);
  const loadToleranceMW = Math.max(5, row.B * 0.0025);

  // MAVIR's extended load (B) and generation (D) both add SCTE + HMKE PV to
  // their operational counterparts (F and G). Their difference from physical
  // net imports can legitimately include losses and other system corrections.
  return Math.abs(row.G - plantMixMW) <= generationToleranceMW
    && Math.abs(row.D - row.G - distributedSolarMW) <= generationToleranceMW
    && Math.abs(row.D - mixTotalMW) <= generationToleranceMW
    && Math.abs(row.B - row.F - distributedSolarMW) <= loadToleranceMW;
}

export function systemSolarComponentsAreCoherent(row) {
  if (![row?.T, row?.U, row?.V].every(Number.isFinite)) return false;
  if (row.T < DISTRIBUTED_SOLAR_COMPLETENESS_THRESHOLD_MW) return true;
  return row.U > 0 && row.V > 0;
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

function plantRecord(key, mw = null) {
  const plant = PLANT_DIRECTORY[key];
  const hasLiveValue = Number.isFinite(mw);
  const utilizationPct = hasLiveValue && Number.isFinite(plant.capacityMW)
    ? rounded((mw / plant.capacityMW) * 100, 1)
    : null;
  return {
    key,
    ...plant,
    mw: hasLiveValue ? rounded(mw) : null,
    liveCoverage: hasLiveValue ? "category_proxy" : "unavailable",
    status: hasLiveValue
      ? (utilizationPct !== null && utilizationPct < 25 ? "Alacsony termelési szint" : (mw > 5 ? "Termelés látható" : "Nem látható termelés"))
      : "Nincs külön élő adat",
    statusTone: hasLiveValue ? (utilizationPct !== null && utilizationPct < 25 ? "attention" : "active") : "unknown",
    utilizationPct,
    statusNote: hasLiveValue
      ? `Az érték a ${plant.liveMetric} országos kategóriából származik, nem blokk- vagy gépegység-szintű státusz.`
      : "A MAVIR 20001-es exportja nem közöl külön létesítményi teljesítményt, ezért az aktuális üzemi állapot ebből a feedből nem állapítható meg.",
  };
}

export function normalizeMavirTables({ systemRows, flowRows, frequencyRows, loadRows, generatedAt = new Date().toISOString() }) {
  const systemColumns = ["B", "D", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W"];
  const flowColumns = [...FLOW_COLUMNS.map(([, column]) => column), ...Object.values(FLOW_SCHEDULE_COLUMNS)];
  const completeSystemRows = systemRows.slice(1).filter((row) => hasFiniteColumns(row, systemColumns) && typeof row.A === "string");
  const systemRow = completeSystemRows.findLast((candidate) => {
    if (!systemRowIsSettled(candidate) || !systemSolarComponentsAreCoherent(candidate)) return false;
    const matchingFlow = nearestComplete(flowRows, flowColumns, candidate.A, "flow");
    const flowTotal = FLOW_COLUMNS.reduce((sum, [, column]) => sum + matchingFlow[column], 0);
    return Math.abs(flowTotal - candidate.W) <= Math.max(350, candidate.B * 0.05);
  });
  invariant(systemRow, "No fully reconciled MAVIR system interval found");
  const provisionalRowsSkipped = completeSystemRows.length - completeSystemRows.indexOf(systemRow) - 1;
  const flowRow = nearestComplete(flowRows, flowColumns, systemRow.A, "flow");
  const frequencyRow = nearestComplete(frequencyRows, ["B"], systemRow.A, "frequency");

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
  const plantGenerationMW = finite(systemRow.G, "power-plant generation");
  const industrialSolarMW = finite(systemRow.T, "industrial PV generation");
  const scteSolarMW = finite(systemRow.U, "SCTE PV generation");
  const householdSolarMW = finite(systemRow.V, "HMKE PV generation");
  const estimatedDistributedSolarMW = scteSolarMW + householdSolarMW;
  const netImportMW = finite(systemRow.W, "net import");
  const mix = mixFromRow(systemRow);
  const mixTotalMW = mix.reduce((sum, item) => sum + item.mw, 0);
  const lowCarbonMW = mix.filter((item) => ["Atom", "Nap", "Egyéb megújuló"].includes(item.key)).reduce((sum, item) => sum + item.mw, 0);
  const lowCarbonSharePct = rounded((lowCarbonMW / generationMW) * 100, 1);
  const flows = FLOW_COLUMNS.map(([code, column]) => {
    const mw = rounded(finite(flowRow[column], `flow ${code}`));
    const scheduledMW = rounded(finite(flowRow[FLOW_SCHEDULE_COLUMNS[code]], `scheduled flow ${code}`));
    return {
      code,
      country: FLOW_COUNTRIES[code],
      mw,
      direction: mw >= 0 ? "import" : "export",
      scheduledMW,
      scheduledDirection: scheduledMW >= 0 ? "import" : "export",
      deviationMW: rounded(mw - scheduledMW),
    };
  });
  const flowTotalMW = flows.reduce((sum, flow) => sum + flow.mw, 0);
  const systemGapMW = consumptionMW - generationMW - netImportMW;
  const mixGapMW = mixTotalMW - generationMW;
  const flowGapMW = flowTotalMW - netImportMW;
  const publishedGenerationMW = rounded(generationMW);
  const publishedPlantGenerationMW = rounded(plantGenerationMW, 1);
  const publishedDistributedSolarMW = rounded(estimatedDistributedSolarMW, 1);
  const generationDefinitionCorrectionMW = rounded(
    publishedGenerationMW - publishedPlantGenerationMW - publishedDistributedSolarMW,
    1,
  );

  invariant(Math.abs(systemGapMW) <= Math.max(750, consumptionMW * 0.12), `System balance difference is implausible (${systemGapMW.toFixed(1)} MW)`);
  const allowedMixGapMW = Math.max(5, generationMW * 0.0025);
  invariant(Math.abs(mixGapMW) <= allowedMixGapMW, `Generation mix does not reconcile (${mixGapMW.toFixed(1)} MW gap)`);
  const allowedFlowGapMW = Math.max(350, consumptionMW * 0.05);
  invariant(Math.abs(flowGapMW) <= allowedFlowGapMW, `Cross-border flows do not reconcile (${flowGapMW.toFixed(1)} MW gap)`);

  const loadHistory24h = loadRows.slice(1)
    .filter((row) => typeof row.A === "string" && hasFiniteColumns(row, ["F", "G"]))
    .map((row) => {
      const actualMW = rounded(row.F);
      const plannedMW = rounded(row.G);
      return {
        time: parseMavirTimestamp(row.A),
        actualMW,
        plannedMW,
        deviationMW: actualMW - plannedMW,
      };
    })
    .filter((point) => (
      Date.parse(point.time) >= Date.parse(measuredAt) - 24 * 60 * 60_000
      && Date.parse(point.time) <= Date.parse(measuredAt) + 5 * 60_000
    ));
  invariant(loadHistory24h.length >= 90, `24-hour MAVIR load plan history is incomplete (${loadHistory24h.length} points)`);
  const latestLoadPoint = loadHistory24h.at(-1);
  const loadPlanLatestOffsetMinutes = Math.abs(Date.parse(latestLoadPoint.time) - Date.parse(measuredAt)) / 60_000;
  invariant(loadPlanLatestOffsetMinutes <= 20, `MAVIR load plan feed is not time-aligned (${loadPlanLatestOffsetMinutes.toFixed(1)} minutes)`);
  const loadPlanMeanAbsoluteErrorMW = loadHistory24h.reduce((sum, point) => sum + Math.abs(point.deviationMW), 0) / loadHistory24h.length;

  const history24h = systemRows.slice(1)
    .filter((row) => hasFiniteColumns(row, systemColumns) && typeof row.A === "string" && systemSolarComponentsAreCoherent(row))
    .map((row) => {
      const rowMix = mixFromRow(row);
      const mixByKey = Object.fromEntries(rowMix.map((item) => [item.key, item.mw]));
      const rowLowCarbonMW = rowMix.filter((item) => ["Atom", "Nap", "Egyéb megújuló"].includes(item.key)).reduce((sum, item) => sum + item.mw, 0);
      const publishedRowGenerationMW = rounded(row.D);
      const publishedRowPlantGenerationMW = rounded(row.G, 1);
      const publishedRowDistributedSolarMW = rounded(row.U + row.V, 1);
      return {
        time: parseMavirTimestamp(row.A),
        loadMW: rounded(row.B),
        generationMW: publishedRowGenerationMW,
        plantGenerationMW: publishedRowPlantGenerationMW,
        importMW: rounded(row.W),
        nuclearMW: mixByKey.Atom,
        solarMW: mixByKey.Nap,
        industrialSolarMW: rounded(row.T, 1),
        scteSolarMW: rounded(row.U, 1),
        householdSolarMW: rounded(row.V, 1),
        estimatedDistributedSolarMW: publishedRowDistributedSolarMW,
        generationDefinitionCorrectionMW: rounded(
          publishedRowGenerationMW - publishedRowPlantGenerationMW - publishedRowDistributedSolarMW,
          1,
        ),
        fossilMW: mixByKey.Fosszilis,
        renewableMW: mixByKey["Egyéb megújuló"],
        otherMW: mixByKey.Egyéb,
        domesticCoveragePct: rounded((row.D / row.B) * 100, 1),
        lowCarbonSharePct: rounded((rowLowCarbonMW / row.D) * 100, 1),
      };
    })
    .filter((point) => Date.parse(point.time) >= Date.parse(measuredAt) - 24 * 60 * 60_000 && Date.parse(point.time) <= Date.parse(measuredAt));
  invariant(history24h.length >= 90, `24-hour MAVIR history is incomplete (${history24h.length} points)`);
  const comparisonTargetMs = Date.parse(measuredAt) - 15 * 60_000;
  const comparisonPoint = history24h.reduce((nearest, point) => (
    Math.abs(Date.parse(point.time) - comparisonTargetMs) < Math.abs(Date.parse(nearest.time) - comparisonTargetMs) ? point : nearest
  ));
  const movementElapsedMinutes = rounded((Date.parse(measuredAt) - Date.parse(comparisonPoint.time)) / 60_000, 1);
  invariant(movementElapsedMinutes >= 10 && movementElapsedMinutes <= 20, `No comparable 15-minute MAVIR point found (${movementElapsedMinutes} minutes)`);
  const movement15m = {
    comparisonAt: comparisonPoint.time,
    elapsedMinutes: movementElapsedMinutes,
    consumptionMW: rounded(consumptionMW - comparisonPoint.loadMW),
    generationMW: rounded(generationMW - comparisonPoint.generationMW),
    netImportMW: rounded(netImportMW - comparisonPoint.importMW),
    domesticCoveragePct: rounded((generationMW / consumptionMW) * 100 - comparisonPoint.domesticCoveragePct, 1),
    lowCarbonSharePct: rounded(lowCarbonSharePct - comparisonPoint.lowCarbonSharePct, 1),
  };

  return {
    schemaVersion: 5,
    generatedAt: new Date(generatedAt).toISOString(),
    measuredAt,
    status: "verified_snapshot",
    source: {
      primary: "MAVIR RTDW",
      systemUrl: "https://www.mavir.hu/web/mavir/rendszerterheles",
      exportBaseUrl: "https://rtdwweb.mavir.hu/rtdwweb/webuser/chart",
      charts: { systemAndMix: 20001, crossBorderFlows: 5229, frequency: 4444, loadPlanActual: 7678 },
      price: "ENTSO-E Transparency Platform",
      priceStatus: "unavailable_missing_entsoe_token",
      measurements: { systemAt: measuredAt, distributedSolarAt: measuredAt, flowsAt: flowMeasuredAt, frequencyAt: frequencyMeasuredAt, loadPlanAt: latestLoadPoint.time },
      caveat: "Minden közzétett rendszeradat közvetlenül a MAVIR nyilvános RTDW-exportjából származik.",
    },
    system: {
      frequencyHz: rounded(frequencyRow.B, 3),
      consumptionMW: rounded(consumptionMW),
      generationMW: publishedGenerationMW,
      plantGenerationMW: publishedPlantGenerationMW,
      industrialSolarMW: rounded(industrialSolarMW, 1),
      scteSolarMW: rounded(scteSolarMW, 1),
      householdSolarMW: rounded(householdSolarMW, 1),
      estimatedDistributedSolarMW: publishedDistributedSolarMW,
      generationDefinitionCorrectionMW,
      netImportMW: rounded(netImportMW),
      domesticCoveragePct: rounded((generationMW / consumptionMW) * 100, 1),
      lowCarbonSharePct,
      dayAheadPriceEurMWh: null,
      carbonIntensityGco2Kwh: null,
      carbonIntensityStatus: "insufficient_source_detail",
    },
    mix,
    flows,
    movement15m,
    plants: [
      plantRecord("paks", systemRow.H),
      plantRecord("matra", systemRow.I),
      plantRecord("dunamenti"),
      plantRecord("gonyu"),
    ],
    history24h,
    loadHistory24h,
    quality: {
      requiredFeeds: ["MAVIR 20001", "MAVIR 5229", "MAVIR 4444", "MAVIR 7678"],
      systemGapMW: rounded(systemGapMW, 1),
      flowGapMW: rounded(flowGapMW, 1),
      mixGapMW: rounded(mixGapMW, 1),
      generationDefinitionGapMW: rounded(generationMW - plantGenerationMW - estimatedDistributedSolarMW, 1),
      mixToleranceMW: rounded(allowedMixGapMW, 1),
      maxFeedOffsetMinutes: rounded(alignmentMinutes, 1),
      provisionalRowsSkipped,
      solarCompletenessStatus: "passed",
      loadPlanCoveragePoints: loadHistory24h.length,
      loadPlanLatestOffsetMinutes: rounded(loadPlanLatestOffsetMinutes, 1),
      loadPlanMeanAbsoluteErrorMW: rounded(loadPlanMeanAbsoluteErrorMW, 1),
      checksPassed: 14,
      checksTotal: 14,
    },
  };
}

export function validateNormalizedEnergyData(data) {
  invariant(data?.schemaVersion === 5, "Unsupported energy data schema");
  invariant(!Number.isNaN(Date.parse(data.measuredAt)), "Invalid measurement timestamp");
  invariant(!Number.isNaN(Date.parse(data.generatedAt)), "Invalid snapshot generation timestamp");
  const measuredYear = new Date(data.measuredAt).getUTCFullYear();
  invariant(measuredYear >= 2020 && measuredYear <= 2100, "Implausible measurement timestamp");
  invariant(Date.parse(data.measuredAt) <= Date.parse(data.generatedAt) + 10 * 60_000, "Measurement timestamp is implausibly later than snapshot generation");
  invariant(Date.parse(data.generatedAt) - Date.parse(data.measuredAt) <= MAX_PUBLISHABLE_SOURCE_AGE_MS, "Published MAVIR snapshot is too old");
  invariant(data.source?.primary === "MAVIR RTDW", "Direct MAVIR attribution is missing");
  invariant(data.source?.charts?.crossBorderFlows === 5229, "Direct MAVIR cross-border chart attribution is missing");
  invariant(data.source?.charts?.loadPlanActual === 7678, "Direct MAVIR load plan chart attribution is missing");
  invariant(["available", "unavailable_missing_entsoe_token", "unavailable_fetch_failed"].includes(data.source?.priceStatus), "Price provenance status is missing");
  invariant(["available", "unavailable_fetch_failed"].includes(data.source?.paksOperationalStatus), "OAH Paks provenance status is missing");

  const { frequencyHz, consumptionMW, generationMW, plantGenerationMW, industrialSolarMW, scteSolarMW, householdSolarMW, estimatedDistributedSolarMW, generationDefinitionCorrectionMW, netImportMW, domesticCoveragePct } = data.system ?? {};
  [frequencyHz, consumptionMW, generationMW, netImportMW, domesticCoveragePct].forEach((value, index) => finite(value, `system metric ${index}`));
  [plantGenerationMW, industrialSolarMW, scteSolarMW, householdSolarMW, estimatedDistributedSolarMW, generationDefinitionCorrectionMW].forEach((value, index) => finite(value, `generation definition metric ${index}`));
  invariant(frequencyHz >= 49 && frequencyHz <= 51, "Grid frequency is outside the plausible validation range");
  invariant(consumptionMW > 0 && consumptionMW < 20_000, "Consumption is outside the plausible validation range");
  invariant(generationMW >= 0 && generationMW < 20_000, "Generation is outside the plausible validation range");
  invariant(Math.abs(estimatedDistributedSolarMW - scteSolarMW - householdSolarMW) <= 1, "Distributed PV components do not reconcile");
  invariant(
    industrialSolarMW < DISTRIBUTED_SOLAR_COMPLETENESS_THRESHOLD_MW || (scteSolarMW > 0 && householdSolarMW > 0),
    "Distributed PV components are missing while industrial solar production is substantial",
  );
  const distributedSolarAt = data.source?.measurements?.distributedSolarAt
    ?? data.source?.measurements?.systemAt;
  invariant(distributedSolarAt === data.measuredAt, "Distributed PV measurement timestamp is not aligned with the coherent system interval");
  invariant(Math.abs(generationMW - plantGenerationMW - estimatedDistributedSolarMW - generationDefinitionCorrectionMW) <= 0.2, "MAVIR generation definitions do not reconcile");
  invariant(Math.abs(netImportMW) < 10_000, "Net import is outside the plausible validation range");
  invariant(domesticCoveragePct >= 0 && domesticCoveragePct <= 250, "Domestic coverage is outside the plausible validation range");

  const expectedMixKeys = ["Atom", "Nap", "Fosszilis", "Egyéb megújuló", "Egyéb"];
  invariant(Array.isArray(data.mix) && expectedMixKeys.every((key) => data.mix.some((item) => item.key === key)), "Generation mix categories are incomplete");
  data.mix.forEach((item) => invariant(Number.isFinite(item.mw) && item.mw >= 0, `Invalid generation mix value: ${item.key}`));
  const mixTotalMW = data.mix.reduce((sum, item) => sum + item.mw, 0);
  invariant(Math.abs(mixTotalMW - generationMW) <= Math.max(5, generationMW * 0.0025), "Published generation mix does not reconcile");
  const solarMixMW = data.mix.find((item) => item.key === "Nap")?.mw;
  invariant(Math.abs(solarMixMW - industrialSolarMW - estimatedDistributedSolarMW) <= 1, "Solar generation definitions do not reconcile");
  const lowCarbonMW = data.mix.filter((item) => ["Atom", "Nap", "Egyéb megújuló"].includes(item.key)).reduce((sum, item) => sum + item.mw, 0);
  finite(data.system.lowCarbonSharePct, "low-carbon generation share");
  invariant(Math.abs(data.system.lowCarbonSharePct - (lowCarbonMW / generationMW) * 100) <= 0.2, "Low-carbon generation share does not match the published mix");

  invariant(data.market?.status === data.source.priceStatus, "Market-price status is inconsistent");
  if (data.market.status === "available") {
    invariant(data.market.source === "ENTSO-E Transparency Platform" && data.market.documentType === "A44", "Direct ENTSO-E market attribution is missing");
    invariant(data.market.current || data.market.nextDay, "Available market data has no usable price");
    if (data.market.current) {
      finite(data.market.current.eurMWh, "current day-ahead price");
      invariant(data.system.dayAheadPriceEurMWh === data.market.current.eurMWh, "Headline market price does not match the current interval");
    } else {
      invariant(data.system.dayAheadPriceEurMWh === null, "A missing current interval must not have a headline price");
    }
    if (data.market.today) {
      invariant(data.market.today.deliveryDate === new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Budapest",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(data.generatedAt)), "Current-day price series has the wrong delivery date");
      invariant(Array.isArray(data.market.today.points) && data.market.today.points.length >= 23 && data.market.today.points.length <= 100, "Current-day price series is incomplete");
      data.market.today.points.forEach((point, index) => {
        invariant(!Number.isNaN(Date.parse(point.start)) && !Number.isNaN(Date.parse(point.end)), `market.today.points[${index}] has an invalid timestamp`);
        finite(point.eurMWh, `market.today.points[${index}].eurMWh`);
        if (index > 0) invariant(Date.parse(point.start) > Date.parse(data.market.today.points[index - 1].start), "Current-day price series is not chronological");
      });
      if (data.market.current) {
        const matchingPoint = data.market.today.points.find((point) => point.start === data.market.current.start);
        invariant(matchingPoint?.eurMWh === data.market.current.eurMWh, "Headline market price does not match the daily series");
      }
    }
    if (data.market.nextDay) {
      [data.market.nextDay.averageEurMWh, data.market.nextDay.minEurMWh, data.market.nextDay.maxEurMWh].forEach((value, index) => finite(value, `next-day market metric ${index}`));
      invariant(data.market.nextDay.minEurMWh <= data.market.nextDay.averageEurMWh && data.market.nextDay.averageEurMWh <= data.market.nextDay.maxEurMWh, "Next-day market summary is inconsistent");
      invariant(data.market.nextDay.periods >= 23 && data.market.nextDay.periods <= 100, "Next-day market period count is implausible");
    }
  } else {
    invariant(data.system.dayAheadPriceEurMWh === null, "Unavailable market price must remain null");
  }

  invariant(data.annualEmissions?.status === "available", "Official annual emissions data is unavailable");
  invariant(data.annualEmissions.source === "EEA GHG Inventory" && data.annualEmissions.sectorCode === "1.A.1.a", "Annual emissions provenance is missing");
  invariant(data.annualEmissions.latest.year === data.annualEmissions.previous.year + 1, "Annual emissions years are not consecutive");
  finite(data.annualEmissions.latest.valueMt, "latest annual emissions");
  finite(data.annualEmissions.previous.valueMt, "previous annual emissions");
  finite(data.annualEmissions.changePct, "annual emissions change");
  invariant(Math.abs(data.annualEmissions.changePct - ((data.annualEmissions.latest.valueMt - data.annualEmissions.previous.valueMt) / data.annualEmissions.previous.valueMt) * 100) <= 0.2, "Annual emissions change does not reconcile");

  const paks = data.plants?.find((plant) => plant.key === "paks");
  invariant(paks && Number.isFinite(paks.mavirCategoryMW), "Paks MAVIR comparison value is missing");
  invariant(paks.operationalDataStatus === data.source.paksOperationalStatus, "Paks operational provenance is inconsistent");
  if (paks.liveCoverage === "block_level") {
    invariant(data.source.paksOperationalStatus === "available", "Block-level Paks data must come from an available OAH feed");
    invariant(Array.isArray(paks.blocks) && paks.blocks.length === 4, "OAH Paks block series is incomplete");
    paks.blocks.forEach((block, index) => {
      invariant(block.block === index + 1, "OAH Paks block identifiers are invalid");
      invariant(Number.isFinite(block.mw) && block.mw >= 0 && block.mw <= 600, "OAH Paks block output is implausible");
    });
    const paksBlockTotalMW = paks.blocks.reduce((sum, block) => sum + block.mw, 0);
    invariant(Math.abs(paksBlockTotalMW - paks.mw) <= 1, "OAH Paks blocks do not reconcile to the plant total");
    invariant(!Number.isNaN(Date.parse(paks.operationalMeasuredAt)), "OAH Paks measurement timestamp is invalid");
    invariant(Date.parse(data.generatedAt) - Date.parse(paks.operationalMeasuredAt) <= 24 * 60 * 60_000, "OAH Paks operational data is stale");
    finite(data.quality.paksVsMavirGapMW, "Paks OAH/MAVIR comparison gap");
    invariant(Math.abs(data.quality.paksVsMavirGapMW - (paks.mw - paks.mavirCategoryMW)) <= 1, "Paks OAH/MAVIR comparison gap is inconsistent");
  } else {
    invariant(paks.liveCoverage === "category_proxy" && data.source.paksOperationalStatus === "unavailable_fetch_failed", "Paks fallback status is inconsistent");
  }

  const expectedFlowCodes = Object.keys(FLOW_COUNTRIES);
  invariant(Array.isArray(data.flows) && expectedFlowCodes.every((code) => data.flows.some((flow) => flow.code === code)), "Cross-border countries are incomplete");
  data.flows.forEach((flow) => {
    finite(flow.mw, `flow.${flow.code}.mw`);
    invariant(flow.direction === (flow.mw >= 0 ? "import" : "export"), `flow.${flow.code} direction contradicts its sign`);
    finite(flow.scheduledMW, `flow.${flow.code}.scheduledMW`);
    finite(flow.deviationMW, `flow.${flow.code}.deviationMW`);
    invariant(flow.scheduledDirection === (flow.scheduledMW >= 0 ? "import" : "export"), `flow.${flow.code} scheduled direction contradicts its sign`);
    invariant(Math.abs(flow.deviationMW - (flow.mw - flow.scheduledMW)) <= 1, `flow.${flow.code} deviation does not reconcile`);
  });
  const flowTotalMW = data.flows.reduce((sum, flow) => sum + flow.mw, 0);
  invariant(Math.abs(flowTotalMW - netImportMW) <= Math.max(350, consumptionMW * 0.05), "Published cross-border flows differ implausibly from the MAVIR net-import series");

  invariant(Array.isArray(data.history24h) && data.history24h.length >= 90, "24-hour history is incomplete");
  data.history24h.forEach((point, index) => {
    invariant(!Number.isNaN(Date.parse(point.time)), `history[${index}] has an invalid timestamp`);
    finite(point.loadMW, `history[${index}].loadMW`);
    finite(point.generationMW, `history[${index}].generationMW`);
    finite(point.importMW, `history[${index}].importMW`);
    const historicalMixKeys = ["nuclearMW", "solarMW", "fossilMW", "renewableMW", "otherMW"];
    historicalMixKeys.forEach((key) => finite(point[key], `history[${index}].${key}`));
    ["plantGenerationMW", "industrialSolarMW", "scteSolarMW", "householdSolarMW", "estimatedDistributedSolarMW", "generationDefinitionCorrectionMW"].forEach((key) => finite(point[key], `history[${index}].${key}`));
    const historicalMixTotalMW = historicalMixKeys.reduce((sum, key) => sum + point[key], 0);
    invariant(Math.abs(historicalMixTotalMW - point.generationMW) <= Math.max(5, point.generationMW * 0.0025), `history[${index}] generation mix does not reconcile`);
    invariant(Math.abs(point.estimatedDistributedSolarMW - point.scteSolarMW - point.householdSolarMW) <= 1, `history[${index}] distributed PV does not reconcile`);
    invariant(Math.abs(point.generationMW - point.plantGenerationMW - point.estimatedDistributedSolarMW - point.generationDefinitionCorrectionMW) <= 0.2, `history[${index}] generation definitions do not reconcile`);
    finite(point.domesticCoveragePct, `history[${index}].domesticCoveragePct`);
    finite(point.lowCarbonSharePct, `history[${index}].lowCarbonSharePct`);
    if (index > 0) invariant(Date.parse(point.time) > Date.parse(data.history24h[index - 1].time), "24-hour history is not chronological");
  });

  invariant(Array.isArray(data.loadHistory24h) && data.loadHistory24h.length >= 90, "24-hour load plan history is incomplete");
  data.loadHistory24h.forEach((point, index) => {
    invariant(!Number.isNaN(Date.parse(point.time)), `loadHistory[${index}] has an invalid timestamp`);
    finite(point.actualMW, `loadHistory[${index}].actualMW`);
    finite(point.plannedMW, `loadHistory[${index}].plannedMW`);
    finite(point.deviationMW, `loadHistory[${index}].deviationMW`);
    invariant(point.actualMW > 0 && point.actualMW < 20_000, `loadHistory[${index}] actual load is implausible`);
    invariant(point.plannedMW > 0 && point.plannedMW < 20_000, `loadHistory[${index}] planned load is implausible`);
    invariant(Math.abs(point.deviationMW - (point.actualMW - point.plannedMW)) <= 0.2, `loadHistory[${index}] deviation does not reconcile`);
    if (index > 0) invariant(Date.parse(point.time) > Date.parse(data.loadHistory24h[index - 1].time), "24-hour load plan history is not chronological");
  });
  const latestLoadPoint = data.loadHistory24h.at(-1);
  const loadPlanLatestOffsetMinutes = Math.abs(Date.parse(latestLoadPoint.time) - Date.parse(data.measuredAt)) / 60_000;
  invariant(loadPlanLatestOffsetMinutes <= 20, "MAVIR load plan history is not aligned with the system snapshot");
  invariant(data.quality?.loadPlanCoveragePoints === data.loadHistory24h.length, "Load plan coverage count is inconsistent");
  invariant(Math.abs(data.quality?.loadPlanLatestOffsetMinutes - loadPlanLatestOffsetMinutes) <= 0.2, "Load plan offset metric is inconsistent");
  const loadPlanMeanAbsoluteErrorMW = data.loadHistory24h.reduce((sum, point) => sum + Math.abs(point.deviationMW), 0) / data.loadHistory24h.length;
  invariant(Math.abs(data.quality?.loadPlanMeanAbsoluteErrorMW - loadPlanMeanAbsoluteErrorMW) <= 0.2, "Load plan mean absolute error is inconsistent");

  invariant(!Number.isNaN(Date.parse(data.movement15m?.comparisonAt)), "15-minute comparison timestamp is invalid");
  invariant(data.movement15m.elapsedMinutes >= 10 && data.movement15m.elapsedMinutes <= 20, "15-minute comparison window is invalid");
  const comparisonPoint = data.history24h.find((point) => point.time === data.movement15m.comparisonAt);
  invariant(comparisonPoint, "15-minute comparison point is missing from history");
  const expectedMovement = {
    consumptionMW: consumptionMW - comparisonPoint.loadMW,
    generationMW: generationMW - comparisonPoint.generationMW,
    netImportMW: netImportMW - comparisonPoint.importMW,
    domesticCoveragePct: domesticCoveragePct - comparisonPoint.domesticCoveragePct,
    lowCarbonSharePct: data.system.lowCarbonSharePct - comparisonPoint.lowCarbonSharePct,
  };
  Object.entries(expectedMovement).forEach(([key, value]) => {
    finite(data.movement15m[key], `movement15m.${key}`);
    invariant(Math.abs(data.movement15m[key] - value) <= 0.2, `movement15m.${key} does not reconcile`);
  });

  invariant(data.quality?.checksPassed === data.quality?.checksTotal && data.quality.checksTotal >= 6, "Not all data quality checks passed");
  invariant(data.quality.enrichment?.lowCarbonShare === "passed", "Low-carbon enrichment validation is missing");
  invariant(data.quality.enrichment?.marketPrice === data.market.status, "Market-price enrichment status is inconsistent");
  invariant(data.quality.enrichment?.annualEmissions === "available", "Annual-emissions enrichment validation is missing");
  invariant(data.quality.enrichment?.paksOperational === data.source.paksOperationalStatus, "Paks operational enrichment status is inconsistent");
  const systemGapMW = consumptionMW - generationMW - netImportMW;
  invariant(Math.abs(systemGapMW - data.quality.systemGapMW) <= 1, "Declared system gap does not match the published metrics");
  invariant(Math.abs(systemGapMW) <= Math.max(750, consumptionMW * 0.12), "Published system balance difference is implausible");
  invariant(data.quality.maxFeedOffsetMinutes <= 20, "Published feeds are not time-aligned");
  invariant(Number.isInteger(data.quality.provisionalRowsSkipped) && data.quality.provisionalRowsSkipped >= 0, "Invalid provisional-row count");
  invariant(
    data.quality.solarCompletenessStatus == null || data.quality.solarCompletenessStatus === "passed",
    "Distributed PV completeness validation is invalid",
  );
  return data;
}
