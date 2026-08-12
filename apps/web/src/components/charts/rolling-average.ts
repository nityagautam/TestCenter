/**
 * Trailing average over the most recent measured points.
 *
 * A missing current value remains a gap rather than carrying the previous average forward,
 * which would claim a run duration was measured when it was not. Earlier missing values are
 * skipped so one incomplete publish does not shorten the trend for the next four runs.
 */
export function rollingAverage(values: (number | null)[], windowSize: number): (number | null)[] {
  const size = Math.max(1, Math.floor(windowSize));

  return values.map((value, index) => {
    if (value === null) return null;

    const window: number[] = [];
    for (let cursor = index; cursor >= 0 && window.length < size; cursor -= 1) {
      const candidate = values[cursor];
      if (candidate !== null && candidate !== undefined) window.push(candidate);
    }

    return window.reduce((sum, candidate) => sum + candidate, 0) / window.length;
  });
}
