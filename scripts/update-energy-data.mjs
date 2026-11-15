import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeMavirTables, validateNormalizedEnergyData } from "../src/data/energy-schema.mjs";
import { applyEnergyEnrichment, fetchEeaAnnualEmissions, fetchEntsoePrices, fetchHaeaPaksOperational } from "../src/data/energy-enrichment.mjs";
import { parseFirstWorksheet } from "./lib/xlsx-table.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "public", "data", "energy-latest.json");
// MAVIR RTDW starts throttling when exports are requested less than ~10 s apart.
const MAVIR_REQUEST_SPACING_MS = 10_000;
const MAVIR_THROTTLE_BACKOFF_MS = 15_000;
const baseUrl = "https://rtdwweb.mavir.hu/rtdwweb/webuser/chart";
const endTime = Date.now();
const startTime = endTime - 26 * 60 * 60_000;
const generatedAt = new Date().toISOString();

async function readPreviousSnapshot() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchChart(chartId) {
  const url = new URL(`${baseUrl}/${chartId}/export`);
  url.search = new URLSearchParams({
    exportType: "xlsx",
    fromTime: String(startTime),
    toTime: String(endTime),
    periodType: "min",
    period: "15",
  });

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        // MAVIR RTDW throttles bursts with 429 or with an HTML "404 HIBA" page
        // for an otherwise valid export URL; both are retried with backoff.
        if (response.status === 429 || response.status === 404) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          error.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1_000
            : MAVIR_THROTTLE_BACKOFF_MS * attempt;
        }
        throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.subarray(0, 2).toString("ascii") !== "PK") throw new Error("response is not an XLSX file");
      return parseFirstWorksheet(buffer);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(error.retryAfterMs ?? attempt * 2_000);
    }
  }
  throw new Error(`MAVIR chart ${chartId} failed after 4 attempts: ${lastError.message}`);
}

const previousSnapshot = await readPreviousSnapshot();
const systemRows = await fetchChart(20001);
await delay(MAVIR_REQUEST_SPACING_MS);
const flowRows = await fetchChart(5229);
await delay(MAVIR_REQUEST_SPACING_MS);
const frequencyRows = await fetchChart(4444);
await delay(MAVIR_REQUEST_SPACING_MS);
const loadRows = await fetchChart(7678);
const annualEmissions = await fetchEeaAnnualEmissions(generatedAt).catch((error) => {
  if (previousSnapshot?.annualEmissions?.status === "available") {
    console.warn(`EEA refresh failed; retaining the last validated annual inventory: ${error.message}`);
    return previousSnapshot.annualEmissions;
  }
  throw error;
});

const market = await fetchEntsoePrices(process.env.ENTSOE_SECURITY_TOKEN, generatedAt).catch(() => ({
  status: "unavailable_fetch_failed",
  source: "ENTSO-E Transparency Platform",
  documentType: "A44",
  biddingZone: "10YHU-MAVIR----U",
}));
const paksOperational = await fetchHaeaPaksOperational(generatedAt).catch(() => ({
  status: "unavailable_fetch_failed",
  source: "Országos Atomenergia Hivatal",
  sourceUrl: "https://www.haea.hu/web/v3/OAHPortal.nsf/web?OpenAgent&article=paksnpp",
}));
const normalized = validateNormalizedEnergyData(applyEnergyEnrichment(
  normalizeMavirTables({ systemRows, flowRows, frequencyRows, loadRows, generatedAt }),
  { market, annualEmissions, paksOperational },
));
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  output: outputPath,
  measuredAt: normalized.measuredAt,
  sources: normalized.quality.requiredFeeds,
  quality: normalized.quality,
  generationMW: normalized.system.generationMW,
  consumptionMW: normalized.system.consumptionMW,
  netImportMW: normalized.system.netImportMW,
  lowCarbonSharePct: normalized.system.lowCarbonSharePct,
  marketStatus: normalized.market.status,
  paksOperational: normalized.plants.find((plant) => plant.key === "paks"),
  annualEmissions: normalized.annualEmissions,
}, null, 2));
