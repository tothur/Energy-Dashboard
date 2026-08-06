import assert from "node:assert/strict";
import test from "node:test";
import { fetchEntsoePrices, normalizeEeaAnnualEmissions, parseEntsoePriceDocument, parseHaeaPaksOperationalPage } from "../src/data/energy-enrichment.mjs";

function entsoeFixture() {
  const points = Array.from({ length: 192 }, (_, index) => `
    <Point><position>${index + 1}</position><price.amount>${50 + (index % 20)}</price.amount></Point>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <Publication_MarketDocument>
      <currency_Unit.name>EUR</currency_Unit.name>
      <price_Measure_Unit.name>MWH</price_Measure_Unit.name>
      <TimeSeries><Period>
        <timeInterval><start>2026-08-04T22:00Z</start><end>2026-08-06T22:00Z</end></timeInterval>
        <resolution>PT15M</resolution>${points}
      </Period></TimeSeries>
    </Publication_MarketDocument>`;
}

test("ENTSO-E A44 prices preserve the current interval and next-day summary", () => {
  const market = parseEntsoePriceDocument(entsoeFixture(), "2026-08-05T10:10:00.000Z");
  assert.equal(market.status, "available");
  assert.equal(market.documentType, "A44");
  assert.equal(market.current.start, "2026-08-05T10:00:00.000Z");
  assert.equal(market.current.eurMWh, 58);
  assert.equal(market.today.deliveryDate, "2026-08-05");
  assert.equal(market.today.points.length, 96);
  assert.deepEqual(market.today.points[0], {
    start: "2026-08-04T22:00:00.000Z",
    end: "2026-08-04T22:15:00.000Z",
    eurMWh: 50,
  });
  assert.equal(market.nextDay.deliveryDate, "2026-08-06");
  assert.equal(market.nextDay.periods, 96);
  assert.ok(market.nextDay.minEurMWh <= market.nextDay.averageEurMWh);
  assert.ok(market.nextDay.averageEurMWh <= market.nextDay.maxEurMWh);
});

test("ENTSO-E access fails visibly when the token is missing", async () => {
  const market = await fetchEntsoePrices("", "2026-08-05T10:10:00.000Z");
  assert.equal(market.status, "unavailable_missing_entsoe_token");
});

test("EEA annual inventory change reconciles to consecutive reported years", () => {
  const emissions = normalizeEeaAnnualEmissions([
    { country_code: "HU", inventory_year: 2024, value: 7111.730322604167, unit: "kt CO₂ equivalent", isCalculatedByEEA: 0, sector_number: "1.A.1.a", submission_version: "20260315" },
    { country_code: "HU", inventory_year: 2023, value: 7469.363873871921, unit: "kt CO₂ equivalent", isCalculatedByEEA: 0, sector_number: "1.A.1.a", submission_version: "20260315" },
  ], "2026-08-05T10:10:00.000Z");
  assert.deepEqual(emissions.latest, { year: 2024, valueMt: 7.112 });
  assert.deepEqual(emissions.previous, { year: 2023, valueMt: 7.469 });
  assert.equal(emissions.changePct, -4.8);
});

test("OAH Paks page preserves the measurement time and all four block outputs", () => {
  const paks = parseHaeaPaksOperationalPage(`
    <h1>A Paksi Atomerőmű aktuális üzemi adatai</h1>
    <tr><td colspan="4">Mérés dátuma: 2026. 08. 06 21:04</td></tr>
    <tr><td>1. blokk</td><td>2. blokk</td><td>3. blokk</td><td>4. blokk</td></tr>
    <tr><td style="color: blue">0 MW</td><td style="color: blue">225 MW</td><td style="color: blue">0 MW</td><td style="color: blue">0 MW</td></tr>
  `, "2026-08-06T19:15:00.000Z");

  assert.equal(paks.measuredAt, "2026-08-06T19:04:00.000Z");
  assert.deepEqual(paks.blocks, [
    { block: 1, mw: 0 },
    { block: 2, mw: 225 },
    { block: 3, mw: 0 },
    { block: 4, mw: 0 },
  ]);
  assert.equal(paks.totalMW, 225);
  assert.equal(paks.source, "Országos Atomenergia Hivatal");
});
