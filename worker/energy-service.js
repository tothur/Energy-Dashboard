import { applyEnergyEnrichment, fetchEntsoePrices, fetchHaeaPaksOperational } from "../src/data/energy-enrichment.mjs";
import { normalizeMavirTables, validateNormalizedEnergyData } from "../src/data/energy-schema.mjs";
import { parseFirstWorksheet } from "./xlsx-table.js";

const MAVIR_EXPORT_BASE = "https://rtdwweb.mavir.hu/rtdwweb/webuser/chart";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchChart(chartId, startTime, endTime) {
  const url = new URL(`${MAVIR_EXPORT_BASE}/${chartId}/export`);
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
        const error = new Error(`MAVIR chart ${chartId}: HTTP ${response.status}`);
        if (response.status === 429) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          error.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1_000
            : attempt * 10_000;
        }
        throw error;
      }
      const buffer = await response.arrayBuffer();
      const signature = new Uint8Array(buffer, 0, 2);
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new Error("MAVIR response is not an XLSX file");
      return parseFirstWorksheet(buffer);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(error.retryAfterMs ?? attempt * 2_000);
    }
  }
  throw new Error(`MAVIR chart ${chartId} failed after 4 attempts: ${lastError.message}`);
}

export async function refreshEnergySnapshot(env, previousSnapshot) {
  if (previousSnapshot?.annualEmissions?.status !== "available") {
    throw new Error("A validated annual emissions baseline is required");
  }

  const generatedAt = new Date().toISOString();
  const endTime = Date.now();
  const startTime = endTime - 26 * 60 * 60_000;
  const systemRows = await fetchChart(20001, startTime, endTime);
  await delay(2_000);
  const flowRows = await fetchChart(5229, startTime, endTime);
  await delay(2_000);
  const frequencyRows = await fetchChart(4444, startTime, endTime);
  await delay(2_000);
  const loadRows = await fetchChart(7678, startTime, endTime);
  const market = await fetchEntsoePrices(env.ENTSOE_SECURITY_TOKEN, generatedAt).catch(() => ({
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
    { market, annualEmissions: previousSnapshot.annualEmissions, paksOperational },
  ));
  normalized.source.delivery = "OpenAI Sites request-driven API";
  return normalized;
}
