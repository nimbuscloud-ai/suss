import { describe, expect, it } from "vitest";

import { ioBinding } from "@suss/behavioral-ir";

import { callSiteKey, numberRepeatedCallSites } from "./callSiteGroup.js";

import type { Effect } from "@suss/behavioral-ir";

function write(groupId?: string, callee = "console.warn"): Effect {
  return {
    type: "interaction",
    binding: ioBinding({ recognition: "test", target: "stderr" }),
    callee,
    ...(groupId === undefined ? {} : { groupId }),
    interaction: { class: "stream-write", payload: null, serialized: "text" },
  };
}

/** One call site's effects, each with the line it was written on. */
function site(...groupIds: string[]): Array<{ effect: Effect; line: number }> {
  return groupIds.map((groupId, line) => ({ effect: write(groupId), line }));
}

function groupIdsOf(
  sites: Array<Array<{ effect: Effect }>>,
): Array<string | undefined> {
  return sites
    .flat()
    .map(({ effect }) =>
      effect.type === "interaction" ? effect.groupId : undefined,
    );
}

describe("callSiteKey", () => {
  it("names the callee and hashes what the effect records", () => {
    const key = callSiteKey(write());
    expect(key).toMatch(/^console\.warn:[0-9a-f]{7}$/);
    expect(callSiteKey(write(undefined, "console.error"))).not.toBe(key);
  });

  it("gives the same key to a call whose chain was only broken across lines", () => {
    expect(callSiteKey(write(undefined, "process.stderr\n  .write"))).toBe(
      callSiteKey(write(undefined, "process.stderr.write")),
    );
  });

  it("gives the same key to the same write on other lines", () => {
    expect(callSiteKey({ ...write(), location: { start: 40, end: 41 } })).toBe(
      callSiteKey({ ...write(), location: { start: 3, end: 3 } }),
    );
  });
});

describe("numberRepeatedCallSites", () => {
  it("numbers the second and later sites that share a key, in the order given", () => {
    const sites = numberRepeatedCallSites([
      site("a"),
      site("b"),
      site("a"),
      site("a"),
    ]);
    expect(groupIdsOf(sites)).toEqual(["a", "b", "a#2", "a#3"]);
  });

  it("keeps every effect from one site under one id", () => {
    const sites = numberRepeatedCallSites([site("a", "a"), site("a", "a")]);
    expect(groupIdsOf(sites)).toEqual(["a", "a", "a#2", "a#2"]);
  });

  it("keeps what an entry records beside its effect", () => {
    const [first] = numberRepeatedCallSites([site("a", "b")]);
    expect(first?.map((entry) => entry.line)).toEqual([0, 1]);
  });
});
