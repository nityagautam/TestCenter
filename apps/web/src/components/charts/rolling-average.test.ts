import { describe, expect, it } from "vitest";
import { rollingAverage } from "./rolling-average";

describe("rollingAverage", () => {
  it("uses a partial window until enough runs exist", () => {
    expect(rollingAverage([10, 20, 30, 40], 3)).toEqual([10, 15, 20, 30]);
  });

  it("preserves missing runs as gaps without discarding earlier measurements", () => {
    expect(rollingAverage([10, null, 20, 30], 3)).toEqual([10, null, 15, 20]);
  });

  it("treats an invalid window size as one run", () => {
    expect(rollingAverage([10, 20], 0)).toEqual([10, 20]);
  });
});
