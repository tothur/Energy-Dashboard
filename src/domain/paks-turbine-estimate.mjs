const TURBINES_PER_BLOCK = 2;

export function estimatePaksTurbines(blockMW, blockCapacityMW) {
  if (!Number.isFinite(blockMW) || !Number.isFinite(blockCapacityMW) || blockCapacityMW <= 0) {
    return {
      label: "NEM BECSÜLHETŐ",
      count: null,
      confidence: "unknown",
      confidenceLabel: "nincs elegendő adat",
    };
  }

  const outputShare = Math.max(0, blockMW) / blockCapacityMW;

  if (blockMW <= Math.max(5, blockCapacityMW * 0.02)) {
    return {
      label: `0/${TURBINES_PER_BLOCK}`,
      count: 0,
      confidence: "high",
      confidenceLabel: "nagy bizonyosság",
    };
  }

  if (outputShare >= 0.82) {
    return {
      label: `2/${TURBINES_PER_BLOCK}`,
      count: 2,
      confidence: "high",
      confidenceLabel: "nagy bizonyosság",
    };
  }

  if (outputShare >= 0.34 && outputShare <= 0.58) {
    return {
      label: `1/${TURBINES_PER_BLOCK}`,
      count: 1,
      confidence: "medium",
      confidenceLabel: "közepes bizonyosság",
    };
  }

  if (outputShare > 0.58) {
    return {
      label: `2/${TURBINES_PER_BLOCK}`,
      count: 2,
      confidence: "medium",
      confidenceLabel: "közepes bizonyosság",
    };
  }

  return {
    label: `1–2/${TURBINES_PER_BLOCK}`,
    count: null,
    confidence: "low",
    confidenceLabel: "alacsony bizonyosság",
  };
}
