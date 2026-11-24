import { describe, expect, it } from "vitest";

import { Evaluator } from "./engine.js";
import {
  assign,
  branch,
  call,
  cond,
  declare,
  expr,
  fn,
  lit,
  loop,
  member,
  module,
  name,
  op,
  record,
  ret,
  type TestNode,
  testLowering,
} from "./testLowering.js";
import { force, literalOf, type Value } from "./value.js";

function evaluator(): Evaluator<TestNode> {
  return new Evaluator(testLowering);
}

function literalUnder(
  target: TestNode,
  arms: Record<string, number>,
  run = evaluator(),
): string | null {
  return literalOf(
    force(run.evaluate(target, { arms: new Map(Object.entries(arms)) })),
  );
}

function keysOf(target: TestNode, arms: Record<string, number> = {}) {
  const met = evaluator().forksIn([target], {
    arms: new Map(Object.entries(arms)),
  });
  return met.forks.map((fork) => ({ key: fork.key, under: fork.under }));
}

describe("a run that takes arms", () => {
  it("reads a record a `?:` picks one arm at a time", () => {
    const target = member(name("target"), "url");
    module([
      fn(
        ["gadget"],
        [
          declare({
            target: cond(
              name("hasId"),
              record({ method: lit("PATCH"), url: lit("/gadgets/1") }),
              record({ method: lit("POST"), url: lit("/gadgets") }),
            ),
          }),
          expr(target),
        ],
      ),
    ]);
    const run = evaluator();
    expect(force(run.evaluate(target)).kind).toBe("hole");
    expect(keysOf(target)).toEqual([{ key: "hasId", under: null }]);
    expect(literalUnder(target, { hasId: 0 }, run)).toBe("/gadgets/1");
    expect(literalUnder(target, { hasId: 1 }, run)).toBe("/gadgets");
    // The plain question after a run with arms is still the joined value.
    expect(force(run.evaluate(target)).kind).toBe("hole");
  });

  it("takes the same arm at every fork that tests the same thing", () => {
    const verb = name("verb");
    const path = name("path");
    module([
      fn(
        ["id"],
        [
          declare({ verb: cond(name("id"), lit("PATCH"), lit("POST")) }),
          declare({ path: cond(name("id"), lit("/x/1"), lit("/x")) }),
          expr(verb),
          expr(path),
        ],
      ),
    ]);
    expect(keysOf(path)).toEqual([{ key: "id", under: null }]);
    expect(literalUnder(verb, { id: 0 })).toBe("PATCH");
    expect(literalUnder(path, { id: 0 })).toBe("/x/1");
    expect(literalUnder(verb, { id: 1 })).toBe("POST");
    expect(literalUnder(path, { id: 1 })).toBe("/x");
  });

  it("fixes a key a guard decided, so a later fork on it is not one", () => {
    const target = name("path");
    module([
      fn(
        ["id"],
        [
          branch(op("!", name("id")), [ret(lit(null))], []),
          declare({ path: cond(name("id"), lit("/x/1"), lit("/x")) }),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([]);
    expect(literalUnder(target, {})).toBe("/x/1");
  });

  it("fixes the key of the arm the target is written in", () => {
    const target = name("path");
    module([
      fn(
        ["flag"],
        [
          branch(name("flag"), [
            declare({ path: cond(name("flag"), lit("/a"), lit("/b")) }),
            expr(target),
          ]),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([]);
    expect(literalUnder(target, {})).toBe("/a");
  });

  it("says the target is not reached when a taken arm returns first", () => {
    const target = name("path");
    module([
      fn(
        ["legacy"],
        [
          declare({ path: lit("/new") }),
          branch(
            name("legacy"),
            [assign(name("path"), lit("/old")), ret(lit(null))],
            [assign(name("path"), lit("/newer"))],
          ),
          expr(target),
        ],
      ),
    ]);
    const met = (arm: number) =>
      evaluator().forksIn([target], { arms: new Map([["legacy", arm]]) });
    expect(met(0).reached).toBe(false);
    expect(met(1).reached).toBe(true);
  });

  it("reports a fork inside an arm only once that arm is taken", () => {
    const target = name("path");
    module([
      fn(
        ["a", "b"],
        [
          branch(
            name("a"),
            [declare({ path: lit("/a") })],
            [
              branch(
                name("b"),
                [declare({ path: lit("/b") })],
                [declare({ path: lit("/c") })],
              ),
            ],
          ),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([{ key: "a", under: null }]);
    expect(keysOf(target, { a: 1 })).toEqual([{ key: "b", under: "a" }]);
    expect(keysOf(target, { a: 0 })).toEqual([]);
    expect(literalUnder(target, { a: 1, b: 0 })).toBe("/b");
    expect(literalUnder(target, { a: 1, b: 1 })).toBe("/c");
  });

  it("reports a fork after a taken arm as beside it, even when the arm left a fork open", () => {
    const target = name("q");
    module([
      fn(
        ["a", "b", "c"],
        [
          branch(
            name("a"),
            [
              branch(
                name("c"),
                [declare({ x: lit("1") })],
                [declare({ x: lit("2") })],
              ),
            ],
            [declare({ x: lit("3") })],
          ),
          declare({ q: cond(name("b"), lit("/1"), lit("/2")) }),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target, { a: 0 })).toEqual([
      { key: "c", under: "a" },
      { key: "b", under: null },
    ]);
  });

  it("splits an else-if chain on one name one arm at a time", () => {
    const target = name("path");
    const isDay = () => op("===", name("period"), lit("day"));
    const isWeek = () => op("===", name("period"), lit("week"));
    module([
      fn(
        ["period"],
        [
          branch(
            isDay(),
            [declare({ path: lit("/daily") })],
            [
              branch(
                isWeek(),
                [declare({ path: lit("/weekly") })],
                [declare({ path: lit("/all") })],
              ),
            ],
          ),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([{ key: "period===day", under: null }]);
    expect(keysOf(target, { "period===day": 1 })).toEqual([
      { key: "period===week", under: "period===day" },
    ]);
  });

  it("leaves a fork joined when a guard on another test read its name", () => {
    const target = name("path");
    module([
      fn(
        ["period"],
        [
          branch(op("===", name("period"), lit("never")), [ret(lit(null))], []),
          declare({ path: cond(name("period"), lit("/a"), lit("/b")) }),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([]);
  });

  it("keeps a key both arms of a branch fixed, and drops one only an arm fixed", () => {
    const target = name("path");
    const guard = () => branch(op("!", name("id")), [ret(lit(null))], []);
    module([
      fn(
        ["a", "b", "id", "flag"],
        [
          branch(
            name("a"),
            [guard(), declare({ x: lit("1") })],
            [guard(), declare({ x: lit("2") })],
          ),
          branch(
            name("b"),
            [
              branch(name("flag"), [ret(lit(null))], []),
              declare({ y: lit("1") }),
            ],
            [declare({ y: lit("2") })],
          ),
          declare({
            path: cond(
              name("id"),
              cond(name("flag"), lit("/x/1/f"), lit("/x/1")),
              lit("/x"),
            ),
          }),
          expr(target),
        ],
      ),
    ]);
    // `flag` is inside the arm the guards fixed, which is where the run
    // is anyway, so it is at the top beside `a` and `b`.
    expect(keysOf(target)).toEqual([
      { key: "a", under: null },
      { key: "b", under: null },
      { key: "flag", under: null },
    ]);
  });

  it("reports a branch where only one arm binds a name", () => {
    const target = name("path");
    module([
      fn(
        ["flag"],
        [
          declare({ path: lit("/x") }),
          branch(name("flag"), [declare({ extra: lit("1") })], []),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([{ key: "flag", under: null }]);
  });

  it("does not report a branch whose arms leave everything as it was", () => {
    const target = name("path");
    module([
      fn(
        ["debug"],
        [
          declare({ path: lit("/x") }),
          branch(name("debug"), [expr(call(null, "log", [lit("hi")]))], []),
          expr(target),
        ],
      ),
    ]);
    expect(keysOf(target)).toEqual([]);
  });

  it("takes an arm of a branch with no condition by its own key", () => {
    const target = name("path");
    const choice = branch(
      null,
      [declare({ path: lit("/one") })],
      [declare({ path: lit("/two") })],
      [declare({ path: lit("/three") })],
    );
    module([fn(["kind"], [choice, expr(target)])]);
    const [fork] = evaluator().forksIn([target]).forks;
    expect(fork?.arms).toBe(3);
    const key = fork?.key ?? "";
    expect(literalUnder(target, { [key]: 2 })).toBe("/three");
  });

  it("leaves a fork in an inlined function and in a loop body joined", () => {
    const helper = fn(["x"], [ret(cond(name("x"), lit("/h1"), lit("/h2")))]);
    const viaHelper = call(null, "helper", [name("flag")], { calls: helper });
    const inLoop = name("looped");
    module([
      helper,
      fn(
        ["flag", "items"],
        [
          declare({ fromHelper: viaHelper }),
          declare({ looped: lit("/l") }),
          loop([branch(name("flag"), [assign(name("looped"), lit("/m"))], [])]),
          expr(name("fromHelper")),
          expr(inLoop),
        ],
      ),
    ]);
    expect(keysOf(viaHelper)).toEqual([]);
    expect(keysOf(inLoop)).toEqual([]);
    const joined: Value = force(
      evaluator().evaluate(viaHelper, { arms: new Map([["x", 0]]) }),
    );
    expect(literalOf(joined)).toBeNull();
  });

  it("keeps apart two forks on a name written between them", () => {
    const verb = name("verb");
    const path = name("path");
    const root = fn(
      ["flag"],
      [
        declare({ verb: cond(name("flag"), lit("PUT"), lit("POST")) }),
        assign(name("flag"), op("!", name("flag"))),
        declare({ path: cond(name("flag"), lit("/a"), lit("/b")) }),
        expr(verb),
        expr(path),
      ],
      { reboundNames: ["flag"] },
    );
    module([root]);
    const keys = evaluator()
      .forksIn([verb, path])
      .forks.map((fork) => fork.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
