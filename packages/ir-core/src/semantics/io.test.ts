import { describe, expect, it } from "vitest";

import { boundaryKey, canPair, displayLabel } from "../boundaryKey.js";
import { namesBoundary } from "../boundarySpelling.js";
import { ioBinding } from "../index.js";

const stdout = ioBinding({
  recognition: "@suss/runtime-node",
  target: "stdout",
});
const unsettled = ioBinding({
  recognition: "@suss/runtime-node",
  target: null,
});

describe("a write to one of the process's streams", () => {
  it("is keyed and labelled by the stream", () => {
    expect(boundaryKey(stdout)).toBe("io:stdout");
    expect(displayLabel(stdout)).toBe("io:stdout");
  });

  it("is picked out by the key and by the bare stream name", () => {
    expect(namesBoundary("io:stdout", stdout)).toBe(true);
    expect(namesBoundary("stdout", stdout)).toBe(true);
    expect(namesBoundary("io:stderr", stdout)).toBe(false);
  });

  it("never pairs, and a stream nobody settled has no key", () => {
    expect(canPair(stdout)).toBe(false);
    expect(boundaryKey(unsettled)).toBeNull();
  });

  it("refuses an empty stream name", () => {
    expect(() => ioBinding({ recognition: "test", target: "" })).toThrow(
      /io target/,
    );
  });
});
