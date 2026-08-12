export function positionTooltip({ x, y, beside }: { x: number; y: number; beside: boolean }): {
  left: string;
  top: string;
  transform: string;
} {
  if (!beside) {
    return {
      left: `${Math.min(Math.max(x, 12), 88)}%`,
      top: `calc(${y}% ${y < 42 ? "+" : "-"} 14px)`,
      transform: y < 42 ? "translate(-50%, 0)" : "translate(-50%, -100%)",
    };
  }

  const opensRight = x < 50;
  const vertical =
    y < 25
      ? { top: `calc(${y}% + 14px)`, transform: "0" }
      : y > 75
        ? { top: `calc(${y}% - 14px)`, transform: "-100%" }
        : { top: `${y}%`, transform: "-50%" };

  return {
    // The horizontal gap clears both the line marker and the widest possible bar. Opening
    // toward the chart centre at either edge also keeps the tooltip inside the card.
    left: `calc(${x}% ${opensRight ? "+" : "-"} 14px)`,
    top: vertical.top,
    transform: `translate(${opensRight ? "0" : "-100%"}, ${vertical.transform})`,
  };
}
