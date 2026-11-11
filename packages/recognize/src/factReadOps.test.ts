import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { type FactSource, factReadOps } from "./factOps.js";
import { global } from "./ops.js";

/**
 * The facts for, in source order:
 *
 *   def need(name, other): return os.environ[name]
 *   os.environ["A"]
 *   os.environ.B or "b"
 *   os.environ["W"] = "1"
 *   need("G", other)
 *
 * and a site the facts state two reads at.
 */
function source(over: Partial<FactSource> = {}): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("func", "needFn");
  add("paramOf", "needFn", "0", "name");
  add("paramOf", "needFn", "1", "other");
  add("readsKeyed", "keyed", "env", "name");
  add("readsEntry", "a", "env", "A");
  add("readsProperty", "b", "env", "B");
  add("readsEntry", "w", "env", "W");
  add("assigns", "w", "one");
  add("readsProperty", "two", "env", "X");
  add("readsProperty", "two", "env", "Y");
  add("call", "needCall", "need");
  add("callArg", "needCall", "0", "g");
  add("callArg", "needCall", "1", "otherRef");
  add("binds", "otherRef", "other");
  add("call", "elsewhere", "unknown");
  add("callArg", "elsewhere", "0", "g");

  const evaluated: Record<string, string> = {
    g: "G",
    one: "1",
    fallbackB: "b",
  };
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: () => null,
    textOf: (key) => `text of ${key}`,
    literalOf: () => null,
    nameOf: () => null,
    argOf: () => null,
    spellsGlobal: (key, path) => key === "env" && path === "os.environ",
    evaluatedOf: (key) => evaluated[key] ?? null,
    comesTo: (key) => (key === "need" ? ["needFn"] : []),
    defaultedAt: (key) => key === "b",
    fallbackOf: (key) => (key === "b" ? "fallbackB" : null),
    readsOff: (key) => (key === "env" ? ["a", "b"] : []),
    sitesNaming: (parameter) =>
      parameter === "name" || parameter === "other" ? ["keyed"] : [],
    ...over,
  };
}

/** The same source with one of the adapter's members left unset. */
function without(member: keyof FactSource): FactSource {
  return Object.fromEntries(
    Object.entries(source()).filter(([key]) => key !== member),
  ) as unknown as FactSource;
}

const ENV = global("os.environ");

describe("the read ops over the facts", () => {
  it("reads the entry a site states, null for a computed key, and none where it states no read or two", () => {
    const facts = source();
    expect(
      ["a", "b", "keyed", "needCall", "two"].map((key) =>
        factReadOps(key, facts).entry(),
      ),
    ).toEqual(["A", "B", null, undefined, undefined]);
  });

  it("says a site is off the object its object is spelled as", () => {
    const facts = source();
    const read = factReadOps("a", facts);
    expect([
      read.isOff(ENV),
      read.isOff(global("process.env")),
      read.isOff({ origin: "handedIn", name: "env" }),
      read.objectPath(["os.environ"]),
      read.objectPath(["os.environ"]),
      factReadOps("needCall", facts).objectPath(["os.environ"]),
    ]).toEqual([true, false, false, "os.environ", "os.environ", undefined]);
  });

  it("says a site is off an object the rules followed into its own, and which of two it cannot say", () => {
    const reachedBy = (paths: string[]) =>
      factReadOps(
        "a",
        source({
          spellsGlobal: () => false,
          globalsReaching: (key) => (key === "env" ? paths : []),
        }),
      );
    expect([
      reachedBy(["os.environ"]).isOff(ENV),
      reachedBy(["os.environ"]).objectPath(["os.environ", "sys.stdout"]),
      reachedBy(["os.environ", "sys.stdout"]).objectPath([
        "os.environ",
        "sys.stdout",
      ]),
      reachedBy(["sys.stdout"]).isOff(ENV),
      factReadOps("a", without("globalsReaching")).isOff(global("x")),
    ]).toEqual([true, "os.environ", null, false, false]);
  });

  it("asks the adapter for the object first when it says so, without stating the site", () => {
    const read = factReadOps(
      "unstated",
      source({ objectOf: (key) => (key === "unstated" ? "env" : null) }),
    );
    expect(read.isOff(ENV)).toBe(true);
  });

  it("takes the adapter's word for whether a read copes and what it falls back to", () => {
    const facts = source();
    const plain = factReadOps("a", facts);
    const defaulted = factReadOps("b", facts);
    expect([
      plain.defaulted(),
      plain.fallback(),
      defaulted.defaulted(),
      defaulted.fallback()?.evaluated?.(),
      factReadOps("a", without("defaultedAt")).defaulted(),
    ]).toEqual([false, null, true, "b", false]);
  });

  it("reads the value a site is assigned, and its source", () => {
    const facts = source();
    expect([
      factReadOps("w", facts).assigned()?.evaluated?.(),
      factReadOps("a", facts).assigned(),
      factReadOps("w", facts).source(),
    ]).toEqual(["1", null, "text of w"]);
  });

  it("reads the sites the adapter says its walk does not visit", () => {
    expect(
      factReadOps("env", source())
        .readsOff()
        .map((site) => site.entry()),
    ).toEqual(["A", "B"]);
    expect(factReadOps("env", without("readsOff")).readsOff()).toEqual([]);
  });

  it("finds the arguments a helper's parameters take a read's key from, and which forward the caller's own", () => {
    const keys = factReadOps("needCall", source()).keysSuppliedTo(ENV) ?? [];
    expect(
      keys.map((key) => [
        key.at,
        key.value.evaluated?.() ?? null,
        key.forwarded,
        key.sites.map((site) => site.entry()),
      ]),
    ).toEqual([
      [0, "G", false, [null]],
      [1, null, true, [null]],
    ]);
  });

  it("finds no key off another object, nor through a callee that comes to no function", () => {
    const facts = source();
    expect(
      factReadOps("needCall", facts).keysSuppliedTo(global("process.env")),
    ).toEqual([]);
    expect(factReadOps("elsewhere", facts).keysSuppliedTo(ENV)).toEqual([]);
    expect(factReadOps("a", facts).keysSuppliedTo(ENV)).toEqual([]);
  });

  it("cannot say which keys a call supplies without the adapter's sites", () => {
    expect(
      factReadOps("needCall", without("sitesNaming")).keysSuppliedTo(ENV),
    ).toBeNull();
  });

  it("takes the keys from the adapter when it works them out itself", () => {
    const facts = source({
      keysSupplied: () => [
        { at: 2, value: "g", forwarded: false, sites: ["keyed"] },
      ],
    });
    const [key] = factReadOps("needCall", facts).keysSuppliedTo(ENV) ?? [];
    expect([key?.at, key?.value.evaluated?.()]).toEqual([2, "G"]);
    expect(
      factReadOps(
        "needCall",
        source({ keysSupplied: () => null }),
      ).keysSuppliedTo(ENV),
    ).toBeNull();
  });
});
