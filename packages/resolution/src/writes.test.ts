import { describe, expect, it } from "vitest";

import { type NameWrite, valueLeftByWrites } from "./writes.js";

function built(key: string, source: string): NameWrite {
  return { value: key, placeholder: false, construction: source };
}

function named(key: string): NameWrite {
  return { value: key, placeholder: false, construction: null };
}

function placeholder(key: string): NameWrite {
  return { value: key, placeholder: true, construction: null };
}

const COMPOUND: NameWrite = {
  value: null,
  placeholder: false,
  construction: null,
};

describe("valueLeftByWrites", () => {
  it("settles on the only value a name is written as", () => {
    expect(valueLeftByWrites([named("a")], true)).toBe("a");
  });

  it("settles on the last write when the writes run in order", () => {
    expect(valueLeftByWrites([named("a"), named("b")], true)).toBe("b");
  });

  it("settles on the last write even when the writes build different things", () => {
    const writes = [built("a", "new Client()"), built("b", "new Other()")];

    expect(valueLeftByWrites(writes, true)).toBe("b");
  });

  it("settles on the construction every unordered write builds", () => {
    const writes = [built("a", "new Client()"), built("b", "new Client()")];

    expect(valueLeftByWrites(writes, false)).toBe("b");
  });

  it("sets a placeholder write aside before comparing constructions", () => {
    const writes = [placeholder("a"), built("b", "new Client()")];

    expect(valueLeftByWrites(writes, false)).toBe("b");
  });

  it("settles on nothing when every unordered write is a placeholder", () => {
    expect(valueLeftByWrites([placeholder("a"), placeholder("b")], false)).toBe(
      null,
    );
  });

  it("settles on nothing when unordered writes build different things", () => {
    const writes = [built("a", "new Client()"), built("b", "new Other()")];

    expect(valueLeftByWrites(writes, false)).toBe(null);
  });

  it("settles on nothing when an unordered write builds nothing", () => {
    const writes = [built("a", "new Client()"), named("b")];

    expect(valueLeftByWrites(writes, false)).toBe(null);
  });

  it("settles on nothing when a write states no value of its own", () => {
    expect(valueLeftByWrites([named("a"), COMPOUND], true)).toBe(null);
  });

  it("settles on nothing when there are no writes", () => {
    expect(valueLeftByWrites([], true)).toBe(null);
  });
});
