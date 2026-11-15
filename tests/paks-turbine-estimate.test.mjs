import test from "node:test";
import assert from "node:assert/strict";

import { estimatePaksTurbines } from "../src/domain/paks-turbine-estimate.mjs";

test("infers no generating turbines from a stopped block", () => {
  assert.deepEqual(estimatePaksTurbines(0, 500), {
    label: "0/2",
    count: 0,
    confidence: "high",
    confidenceLabel: "nagy bizonyosság",
  });
});

test("marks half-block output as probably one turbine", () => {
  assert.deepEqual(estimatePaksTurbines(228, 500), {
    label: "1/2",
    count: 1,
    confidence: "medium",
    confidenceLabel: "közepes bizonyosság",
  });
});

test("infers two turbines at full and above-single-turbine output", () => {
  assert.equal(estimatePaksTurbines(488, 500).label, "2/2");
  assert.equal(estimatePaksTurbines(360, 500).label, "2/2");
  assert.equal(estimatePaksTurbines(360, 500).confidence, "medium");
});

test("keeps deeply reduced output ambiguous", () => {
  assert.deepEqual(estimatePaksTurbines(100, 500), {
    label: "1–2/2",
    count: null,
    confidence: "low",
    confidenceLabel: "alacsony bizonyosság",
  });
});

test("does not estimate without valid block data", () => {
  assert.equal(estimatePaksTurbines(undefined, 500).confidence, "unknown");
  assert.equal(estimatePaksTurbines(228, 0).label, "NEM BECSÜLHETŐ");
});
