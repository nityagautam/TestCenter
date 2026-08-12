import { describe, expect, it } from "vitest";
import { positionTooltip } from "./tooltip-position";

describe("positionTooltip", () => {
  it("places a line tooltip above or below its point", () => {
    expect(positionTooltip({ x: 50, y: 20, beside: false })).toEqual({
      left: "50%",
      top: "calc(20% + 14px)",
      transform: "translate(-50%, 0)",
    });
    expect(positionTooltip({ x: 50, y: 70, beside: false })).toEqual({
      left: "50%",
      top: "calc(70% - 14px)",
      transform: "translate(-50%, -100%)",
    });
  });

  it("places a combo tooltip beside the bar and line marker", () => {
    expect(positionTooltip({ x: 20, y: 50, beside: true })).toEqual({
      left: "calc(20% + 14px)",
      top: "50%",
      transform: "translate(0, -50%)",
    });
    expect(positionTooltip({ x: 80, y: 10, beside: true })).toEqual({
      left: "calc(80% - 14px)",
      top: "calc(10% + 14px)",
      transform: "translate(-100%, 0)",
    });
  });
});
