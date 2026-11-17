import { describe, expect, it } from "vitest";

import { Evaluator } from "./engine.js";
import {
  array,
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
  opaque,
  record,
  ret,
  type TestNode,
  testLowering,
} from "./testLowering.js";
import {
  everyOption,
  hasNoEntries,
  opposite,
  stringIsEmpty,
  truthinessFrom,
} from "./truthiness.js";
import { constant, force, type Value } from "./value.js";

import type { Lowering } from "./language.js";

/** A rule like Python's, where an empty record is false, so a test can see whether an object was widened. */
const emptinessCounts = truthinessFrom({
  constant: ({ options }) => everyOption(options, Boolean),
  string: (value) => opposite(stringIsEmpty(value)),
  sequence: (value) => opposite(hasNoEntries(value)),
  unbounded: () => null,
  record: (value) => opposite(hasNoEntries(value)),
  hole: () => null,
  ref: () => null,
  deferred: () => null,
});

/** A rule like Ruby's, where only null and false are false. */
const onlyNullIsFalse = truthinessFrom({
  constant: ({ options }) =>
    everyOption(options, (option) => option !== null && option !== false),
  string: () => true,
  sequence: () => true,
  unbounded: () => true,
  record: () => true,
  hole: () => null,
  ref: () => null,
  deferred: () => null,
});

function soundly(
  target: TestNode,
  lowering: Lowering<TestNode> = testLowering,
): Value {
  return force(new Evaluator(lowering, { sound: true }).evaluate(target));
}

function truthOf(value: Value, lowering = testLowering): boolean | null {
  return lowering.truthiness(value);
}

/**
 * `loadOrder(id)` returns `toOrder(row)` when a row came back and `{}`
 * when none did, so every value it returns is an object.
 */
function orderHelpers(): { load: TestNode; toOrder: TestNode } {
  const toOrder = fn(["row"], [ret(record({ id: member(name("row"), "id") }))]);
  const load = fn(
    ["id"],
    [
      declare({ row: call(name("db"), "find", [name("id")]) }),
      ret(
        cond(
          name("row"),
          call(null, "toOrder", [name("row")], { calls: toOrder }),
          record({}),
        ),
      ),
    ],
  );
  return { load, toOrder };
}

describe("a sound evaluator", () => {
  it("reads every value a helper returns as an object", () => {
    const { load, toOrder } = orderHelpers();
    const order = name("order");
    const test = op("!", order);
    module([
      toOrder,
      load,
      fn(
        ["req"],
        [
          declare({
            order: call(null, "loadOrder", [member(name("req"), "id")], {
              calls: load,
            }),
          }),
          branch(test, [ret(lit(404))], []),
          ret(lit(200)),
        ],
      ),
    ]);

    expect(truthOf(soundly(order))).toBe(true);
    expect(soundly(test)).toEqual(constant(false));
  });

  it("gives a plain evaluator's join of two objects back as a hole", () => {
    const { load, toOrder } = orderHelpers();
    const target = call(null, "loadOrder", [lit("1")], { calls: load });
    module([toOrder, load, expr(target)]);

    expect(force(new Evaluator(testLowering).evaluate(target)).kind).toBe(
      "hole",
    );
    expect(soundly(target).kind).toBe("record");
  });

  it("reads a parameter nobody passed as a hole", () => {
    const target = op("!", name("req"));
    module([fn(["req"], [branch(target, [ret(lit(400))], [])])]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("reads a name from outside the function as a hole", () => {
    const target = name("EMPTY");
    module([declare({ EMPTY: record({}) }), fn([], [ret(target)])]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("reads a name the function writes more than once as a hole", () => {
    const target = name("order");
    const handler = fn([], [declare({ order: record({}) }), expr(target)], {
      reboundNames: ["order"],
    });
    module([handler]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("reads a parameter its function writes again as a hole when it inlines a call", () => {
    const helper = fn(["value"], [ret(name("value"))], {
      reboundNames: ["value"],
    });
    const target = call(null, "helper", [record({})], { calls: helper });
    module([helper, expr(target)]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("reads a member as a hole", () => {
    const helper = fn([], [ret(record({ order: record({}) }))]);
    const target = member(call(null, "helper", [], { calls: helper }), "order");
    module([helper, expr(target)]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("gives a hole for a helper with a statement nobody could read", () => {
    const helper = fn([], [expr(opaque()), opaque(), ret(record({}))]);
    const target = call(null, "helper", [], { calls: helper });
    module([helper, expr(target)]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("gives a hole for a call it cannot see into", () => {
    const target = call(null, "mystery", []);
    module([expr(target)]);
    expect(soundly(target).kind).toBe("hole");
  });

  it("gives a hole once it runs past its statement budget", () => {
    const helper = fn([], [declare({ a: lit(1) }), ret(record({}))]);
    const target = call(null, "helper", [], { calls: helper });
    module([helper, declare({ b: lit(2) }), expr(target)]);
    const evaluator = new Evaluator(testLowering, {
      sound: true,
      statementBudget: 2,
    });
    expect(force(evaluator.evaluate(target)).kind).toBe("hole");
  });

  it("does not inline a call whose spread leaves the positions unknown", () => {
    const helper = fn(["a"], [ret(record({}))]);
    const target = call(null, "helper", [{ spread: name("rest") }], {
      calls: helper,
    });
    module([fn(["rest"], [expr(target)])]);
    expect(soundly(target).kind).toBe("hole");
  });

  describe("an object code it cannot see may change", () => {
    const lowering = { ...testLowering, truthiness: emptinessCounts };

    it("keeps an object nothing else touched as it was written", () => {
      const target = name("d");
      module([fn([], [declare({ d: record({ a: lit(1) }) }), expr(target)])]);
      expect(truthOf(soundly(target, lowering), lowering)).toBe(true);
    });

    it("widens an object passed to a call it cannot see", () => {
      const target = name("d");
      module([
        fn(
          [],
          [
            declare({ d: record({ a: lit(1) }) }),
            expr(call(null, "clearAll", [name("d")])),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens the receiver of a method call it cannot follow", () => {
      const target = name("d");
      module([
        fn(
          [],
          [
            declare({ d: record({ a: lit(1) }) }),
            expr(call(name("d"), "clear", [])),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens an object inside another one it passed on", () => {
      const target = name("d");
      module([
        fn(
          [],
          [
            declare({ d: record({ a: lit(1) }) }),
            declare({ holder: record({ inner: name("d") }) }),
            expr(call(null, "mystery", [name("holder")])),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens every object after a statement nobody could read", () => {
      const target = name("d");
      module([
        fn([], [declare({ d: record({ a: lit(1) }) }), opaque(), expr(target)]),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens what a function written as a value reads", () => {
      const target = name("d");
      const closure = fn([], [], { freeNames: ["d"] });
      module([
        fn(
          [],
          [
            declare({ d: record({ a: lit(1) }) }),
            declare({ later: closure }),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens an object a loop writes to", () => {
      const target = name("d");
      module([
        fn(
          [],
          [
            declare({ d: record({}) }),
            loop([assign(member(name("d"), "a"), lit(1))]),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("joins two objects as a copy of both and widens both", () => {
      const same = name("same");
      const either = name("either");
      const original = name("a");
      module([
        fn(
          ["flag"],
          [
            declare({ a: record({ k: lit(1) }), b: record({ j: lit(2) }) }),
            declare({ same: cond(name("flag"), name("a"), name("a")) }),
            expr(same),
            declare({ either: cond(name("flag"), name("a"), name("b")) }),
            expr(either),
            expr(original),
          ],
        ),
      ]);
      expect(truthOf(soundly(same, lowering), lowering)).toBe(true);
      expect(truthOf(soundly(either, lowering), lowering)).toBeNull();
      expect(truthOf(soundly(original, lowering), lowering)).toBeNull();
      expect(truthOf(soundly(either))).toBe(true);
    });

    it("joins two objects nothing else refers to without widening them", () => {
      const target = cond(
        name("flag"),
        record({ id: lit(1) }),
        record({ id: lit(2) }),
      );
      module([fn(["flag"], [expr(target)])]);
      expect(truthOf(soundly(target, lowering), lowering)).toBe(true);
    });

    it("reads the object an arm returned before it ended", () => {
      const helper = fn(
        ["flag"],
        [
          branch(name("flag"), [ret(record({ id: lit(1) }))], []),
          ret(record({ id: lit(2) })),
        ],
      );
      const target = call(null, "helper", [name("input")], { calls: helper });
      module([helper, fn(["input"], [expr(target)])]);
      expect(truthOf(soundly(target, lowering), lowering)).toBe(true);
    });

    it("reads every version of an object an arm changed and returned", () => {
      const helper = fn(
        ["flag"],
        [
          declare({ d: record({}) }),
          branch(
            name("flag"),
            [assign(member(name("d"), "id"), lit(1)), ret(name("d"))],
            [],
          ),
          ret(name("d")),
        ],
      );
      const target = call(null, "helper", [name("input")], { calls: helper });
      module([helper, fn(["input"], [expr(target)])]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens every object before a target inside a statement nobody could read", () => {
      const target = name("d");
      const inner = expr(target);
      const wrapper = opaque();
      module([fn([], [declare({ d: record({ a: lit(1) }) }), wrapper])]);
      inner.parent = wrapper;
      target.parent = inner;
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
      const plain = force(new Evaluator(lowering).evaluate(target));
      expect(truthOf(plain, lowering)).toBe(true);
    });

    it("joins one name two arms bound to different objects", () => {
      const target = name("x");
      module([
        fn(
          ["flag"],
          [
            branch(
              name("flag"),
              [declare({ x: record({ k: lit(1) }) })],
              [declare({ x: record({ k: lit(2) }) })],
            ),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBe(true);
    });

    it("joins two settled values that are not objects", () => {
      const target = cond(name("flag"), lit(1), lit(2));
      module([fn(["flag"], [expr(target)])]);
      expect(truthOf(soundly(target, lowering), lowering)).toBe(true);
    });

    it("widens an object a caller passed when a helper joins it with another", () => {
      const helper = fn(
        ["flag", "given"],
        [ret(cond(name("flag"), name("given"), record({ k: lit(2) })))],
      );
      const target = call(
        null,
        "helper",
        [name("flag"), record({ k: lit(1) })],
        { calls: helper },
      );
      module([helper, fn(["flag"], [expr(target)])]);
      const joined = soundly(target, lowering);
      expect(joined.kind).toBe("record");
      expect(truthOf(joined, lowering)).toBeNull();
    });

    it("widens every object after a write to something it cannot follow", () => {
      const target = name("d");
      module([
        fn(
          [],
          [
            declare({ d: record({ a: lit(1) }) }),
            assign(opaque(), lit(1)),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens what a list passed on holds, and what a copy passed on holds", () => {
      const target = name("d");
      module([
        fn(
          ["flag"],
          [
            declare({ d: record({ a: lit(1) }) }),
            declare({ e: record({ b: lit(1) }) }),
            declare({ copy: cond(name("flag"), name("d"), name("e")) }),
            expr(call(null, "mystery", [name("copy")])),
            expr(call(null, "mystery", [array(name("d"))])),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });

    it("widens an object a member read hands out", () => {
      const target = name("d");
      module([
        fn(
          [],
          [
            declare({ d: record({ a: lit(1) }) }),
            declare({ holder: record({ inner: name("d") }) }),
            expr(call(member(name("holder"), "inner"), "clear", [])),
            expr(target),
          ],
        ),
      ]);
      expect(truthOf(soundly(target, lowering), lowering)).toBeNull();
    });
  });

  it("settles a branch by the language's rule", () => {
    const target = name("picked");
    const lowering = { ...testLowering, truthiness: onlyNullIsFalse };
    module([
      fn(
        [],
        [
          declare({ picked: lit("none") }),
          branch(lit(0), [assign(name("picked"), lit("zero is true"))], []),
          expr(target),
        ],
        { reboundNames: [] },
      ),
    ]);
    expect(force(new Evaluator(lowering).evaluate(target))).toEqual(
      force(new Evaluator(lowering).evaluate(lit("zero is true"))),
    );
    expect(force(new Evaluator(testLowering).evaluate(target))).toEqual(
      force(new Evaluator(testLowering).evaluate(lit("none"))),
    );
  });
});
