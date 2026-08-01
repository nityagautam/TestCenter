/**
 * Smooth interpolation for the line and area charts.
 *
 * **Monotone cubic, not Catmull-Rom.** The obvious way to smooth a series is a Catmull-Rom
 * spline, and it is wrong for this data: between two points it overshoots, so a pass rate
 * that goes 100, 96, 100 is drawn bulging *above* 100%, and a duration that dips toward zero
 * is drawn going negative. The chart would be asserting values that never happened and are
 * not possible. Fritsch–Carlson tangents constrain each segment to stay within the two
 * points that bound it, so the curve is smooth and still never claims a value outside the
 * data.
 *
 * That property is the whole reason this is a shared module rather than four lines inlined
 * in each chart: `yMax={100}` on the pass-rate chart clips the *scale*, not the curve, so
 * without this the overshoot would render outside the plot area and be silently cropped.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Tangent at each point, chosen so the interpolant is monotone on every interval.
 *
 * Where the slope changes sign the tangent is flattened to zero — that is what turns a
 * local peak into a rounded crest instead of a loop that climbs past it first.
 */
function tangents(points: Point[]): number[] {
  const count = points.length;
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const run = points[index + 1]!.x - points[index]!.x;
    slopes.push(run === 0 ? 0 : (points[index + 1]!.y - points[index]!.y) / run);
  }

  const result: number[] = new Array(count).fill(0);
  result[0] = slopes[0] ?? 0;
  result[count - 1] = slopes[count - 2] ?? 0;

  for (let index = 1; index < count - 1; index += 1) {
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    // Opposite signs means this point is a local extreme: a horizontal tangent keeps the
    // curve from sailing past it.
    if (before * after <= 0) {
      result[index] = 0;
      continue;
    }
    const average = (before + after) / 2;
    // The Fritsch–Carlson limit. Without the clamp a gentle slope next to a steep one still
    // overshoots, which is exactly the 100%-pass-rate case.
    const limit = 3 * Math.min(Math.abs(before), Math.abs(after));
    result[index] = Math.sign(average) * Math.min(Math.abs(average), limit);
  }

  return result;
}

/**
 * A smooth path through the points, in SVG path syntax.
 *
 * `start` controls the first command: `"M"` begins a subpath, `"L"` continues one — which is
 * what lets an area close back along its lower boundary without a straight seam appearing
 * where the two halves meet.
 */
export function smoothPath(points: Point[], start: "M" | "L" = "M"): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  if (points.length === 1) return `${start}${round(first.x)},${round(first.y)}`;

  const slopes = tangents(points);
  let path = `${start}${round(first.x)},${round(first.y)}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    // Control points sit a third of the interval along each tangent — the standard Hermite
    // to Bézier conversion, which is what SVG can actually draw.
    const third = (to.x - from.x) / 3;
    const c1x = from.x + third;
    const c1y = from.y + slopes[index]! * third;
    const c2x = to.x - third;
    const c2y = to.y - slopes[index + 1]! * third;
    path += ` C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(to.x)},${round(to.y)}`;
  }

  return path;
}

/** Three decimals is well under a device pixel at any width, and keeps the DOM readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
