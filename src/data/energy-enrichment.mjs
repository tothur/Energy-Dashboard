const ENTSOE_API_URL = "https://web-api.tp.entsoe.eu/api";
const HU_BIDDING_ZONE = "10YHU-MAVIR----U";
const EEA_SQL_URL = "https://discodata.eea.europa.eu/sql";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function rounded(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tagValue(text, name) {
  const escaped = name.replaceAll(".", "\\.");
  return text.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${escaped}>([^<]+)<\\/(?:[A-Za-z0-9_-]+:)?${escaped}>`))?.[1] ?? null;
}

function durationMinutes(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(value ?? "");
  invariant(match, `Unsupported ENTSO-E resolution: ${value}`);
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

function localDate(isoTimestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTimestamp));
}

export function parseEntsoePriceDocument(xml, generatedAt = new Date().toISOString()) {
  invariant(typeof xml === "string" && /<.*Publication_MarketDocument/.test(xml), "Invalid ENTSO-E price document");
  const currency = tagValue(xml, "currency_Unit.name") ?? "EUR";
  const unit = tagValue(xml, "price_Measure_Unit.name") ?? "MWH";
  invariant(currency === "EUR" && unit.toUpperCase() === "MWH", `Unexpected ENTSO-E price unit: ${currency}/${unit}`);

  const points = [];
  for (const period of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?Period>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?Period>/g)) {
    const body = period[1];
    const start = tagValue(body, "start");
    const resolution = durationMinutes(tagValue(body, "resolution"));
    invariant(start && !Number.isNaN(Date.parse(start)), "ENTSO-E price period has no valid start time");
    for (const point of body.matchAll(/<(?:[A-Za-z0-9_-]+:)?Point>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?Point>/g)) {
      const position = Number(tagValue(point[1], "position"));
      const eurMWh = Number(tagValue(point[1], "price.amount"));
      invariant(Number.isInteger(position) && position > 0 && Number.isFinite(eurMWh), "Invalid ENTSO-E price point");
      const startMs = Date.parse(start) + (position - 1) * resolution * 60_000;
      points.push({
        start: new Date(startMs).toISOString(),
        end: new Date(startMs + resolution * 60_000).toISOString(),
        eurMWh: rounded(eurMWh, 2),
      });
    }
  }
  invariant(points.length >= 24, `ENTSO-E price series is incomplete (${points.length} points)`);
  points.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const nowMs = Date.parse(generatedAt);
  const current = points.find((point) => Date.parse(point.start) <= nowMs && nowMs < Date.parse(point.end)) ?? null;
  const tomorrowDate = localDate(new Date(nowMs + 24 * 60 * 60_000).toISOString());
  const tomorrowPoints = points.filter((point) => localDate(point.start) === tomorrowDate);
  const nextDay = tomorrowPoints.length >= 23 ? {
    deliveryDate: tomorrowDate,
    averageEurMWh: rounded(tomorrowPoints.reduce((sum, point) => sum + point.eurMWh, 0) / tomorrowPoints.length, 2),
    minEurMWh: Math.min(...tomorrowPoints.map((point) => point.eurMWh)),
    maxEurMWh: Math.max(...tomorrowPoints.map((point) => point.eurMWh)),
    periods: tomorrowPoints.length,
  } : null;

  invariant(current || nextDay, "ENTSO-E document has no current or next-day Hungarian price");
  return {
    status: "available",
    source: "ENTSO-E Transparency Platform",
    documentType: "A44",
    biddingZone: HU_BIDDING_ZONE,
    currency: "EUR",
    unit: "MWh",
    fetchedAt: new Date(generatedAt).toISOString(),
    current,
    nextDay,
  };
}

function entsoePeriod(timestamp) {
  return new Date(timestamp).toISOString().replace(/[-:]/g, "").slice(0, 12);
}

export async function fetchEntsoePrices(token, generatedAt = new Date().toISOString()) {
  if (!token) return {
    status: "unavailable_missing_entsoe_token",
    source: "ENTSO-E Transparency Platform",
    documentType: "A44",
    biddingZone: HU_BIDDING_ZONE,
  };

  const nowMs = Date.parse(generatedAt);
  const url = new URL(ENTSOE_API_URL);
  url.search = new URLSearchParams({
    securityToken: token,
    documentType: "A44",
    in_Domain: HU_BIDDING_ZONE,
    out_Domain: HU_BIDDING_ZONE,
    periodStart: entsoePeriod(nowMs - 24 * 60 * 60_000),
    periodEnd: entsoePeriod(nowMs + 48 * 60 * 60_000),
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`ENTSO-E A44 HTTP ${response.status}`);
  return parseEntsoePriceDocument(await response.text(), generatedAt);
}

// EEA variable: IPCC 1.A.1.a, Aggregate GHGs, Emissions, Fuels, kt CO2 equivalent.
const EEA_POWER_HEAT_VARIABLE = "e7f01e74-bf84-416c-b68b-d71c77630b2b";
const EEA_QUERY = `select top 10 country, country_code, inventory_year, value, notation, isCalculatedByEEA, submission_version
from [GHG_Inventory].[latest].[ghg_value]
where country_code='HU' and variable_uid='${EEA_POWER_HEAT_VARIABLE}'
order by inventory_year desc, submission_version desc`;

export async function fetchEeaAnnualEmissions(generatedAt = new Date().toISOString()) {
  const url = new URL(EEA_SQL_URL);
  url.search = new URLSearchParams({ query: EEA_QUERY, p: "1", nrOfHits: "10" });
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`EEA Discodata HTTP ${response.status}`);
  const payload = await response.json();
  invariant(!payload.errors?.length, `EEA Discodata query failed: ${payload.errors?.[0]?.error ?? "unknown error"}`);
  const rows = (payload.results ?? []).map((row) => ({
    ...row,
    unit: "kt CO₂ equivalent",
    sector_number: "1.A.1.a",
  }));
  return normalizeEeaAnnualEmissions(rows, generatedAt);
}

export function normalizeEeaAnnualEmissions(rows, generatedAt = new Date().toISOString()) {
  invariant(rows.length >= 2, "EEA annual emissions series is incomplete");
  const [latest, previous] = rows;
  invariant(latest.country_code === "HU" && previous.country_code === "HU", "EEA emissions country mismatch");
  invariant(latest.inventory_year === previous.inventory_year + 1, "EEA emissions years are not consecutive");
  invariant(latest.unit === "kt CO₂ equivalent" && previous.unit === latest.unit, "Unexpected EEA emissions unit");
  invariant(Number.isFinite(latest.value) && Number.isFinite(previous.value) && latest.value >= 0 && previous.value > 0, "Invalid EEA emissions value");
  invariant(latest.isCalculatedByEEA === 0 && previous.isCalculatedByEEA === 0, "EEA-derived replacement value must not be presented as reported data");

  return {
    status: "available",
    source: "EEA GHG Inventory",
    sourceUrl: "https://discodata.eea.europa.eu/",
    sectorCode: latest.sector_number,
    scope: "Közüzemi villamosenergia- és hőtermelés",
    unit: "Mt CO₂e",
    latest: { year: latest.inventory_year, valueMt: rounded(latest.value / 1_000, 3) },
    previous: { year: previous.inventory_year, valueMt: rounded(previous.value / 1_000, 3) },
    changePct: rounded(((latest.value - previous.value) / previous.value) * 100, 1),
    submissionVersion: latest.submission_version,
    fetchedAt: new Date(generatedAt).toISOString(),
  };
}

export function applyEnergyEnrichment(data, { market, annualEmissions }) {
  const enriched = structuredClone(data);
  const lowCarbonMW = enriched.mix
    .filter((item) => ["Atom", "Nap", "Egyéb megújuló"].includes(item.key))
    .reduce((sum, item) => sum + item.mw, 0);
  enriched.system.lowCarbonSharePct = rounded((lowCarbonMW / enriched.system.generationMW) * 100, 1);
  enriched.market = market;
  enriched.annualEmissions = annualEmissions;
  enriched.source.price = "ENTSO-E Transparency Platform";
  enriched.source.priceStatus = market.status;
  enriched.source.annualEmissions = annualEmissions?.source ?? "EEA GHG Inventory";
  enriched.system.dayAheadPriceEurMWh = market.status === "available" ? market.current?.eurMWh ?? null : null;
  enriched.quality.enrichment = {
    lowCarbonShare: "passed",
    marketPrice: market.status,
    annualEmissions: annualEmissions?.status ?? "unavailable",
  };
  return enriched;
}
