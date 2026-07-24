export function pearsonCorrelation(
  pairs: Array<{ x: number | null | undefined; y: number | null | undefined }>,
): number | null {
  const validPairs = pairs.filter(
    (pair): pair is { x: number; y: number } =>
      typeof pair.x === "number" &&
      Number.isFinite(pair.x) &&
      typeof pair.y === "number" &&
      Number.isFinite(pair.y),
  );

  if (validPairs.length < 2) {
    return null;
  }

  const xMean = validPairs.reduce((sum, pair) => sum + pair.x, 0) / validPairs.length;
  const yMean = validPairs.reduce((sum, pair) => sum + pair.y, 0) / validPairs.length;

  let numerator = 0;
  let xVariance = 0;
  let yVariance = 0;

  for (const pair of validPairs) {
    const xDelta = pair.x - xMean;
    const yDelta = pair.y - yMean;
    numerator += xDelta * yDelta;
    xVariance += xDelta * xDelta;
    yVariance += yDelta * yDelta;
  }

  const denominator = Math.sqrt(xVariance * yVariance);
  if (denominator === 0) {
    return null;
  }

  return numerator / denominator;
}
