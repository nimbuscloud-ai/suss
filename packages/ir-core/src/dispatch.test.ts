import { describe, expect, it } from "vitest";

import { type DispatchTable, dispatchByType } from "./index.js";

type Shape =
  | { type: "circle"; radius: number }
  | { type: "square"; side: number };

const area: DispatchTable<Shape, number> = {
  circle: (c) => Math.PI * c.radius ** 2,
  square: (s) => s.side ** 2,
};

describe("dispatchByType", () => {
  it("runs the handler the value's type names", () => {
    expect(dispatchByType(area, { type: "square", side: 3 })).toBe(9);
    expect(dispatchByType(area, { type: "circle", radius: 1 })).toBeCloseTo(
      Math.PI,
    );
  });

  it("narrows the variant a handler receives", () => {
    const seen: DispatchTable<Shape, string> = {
      // `c.radius` compiles only because the table narrowed the variant,
      // which is the property the idiom exists for.
      circle: (c) => `r=${c.radius}`,
      square: (s) => `s=${s.side}`,
    };
    expect(dispatchByType(seen, { type: "circle", radius: 2 })).toBe("r=2");
  });
});
