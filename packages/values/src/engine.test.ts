import { describe, expect, it } from "vitest";

import { Evaluator } from "./engine.js";
import { parameter } from "./language.js";
import {
  array,
  assign,
  block,
  branch,
  call,
  computedRecord,
  cond,
  declare,
  element,
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
  template,
  testLowering,
} from "./testLowering.js";
import {
  force,
  hole,
  holePiece,
  literalOf,
  type Piece,
  sequence,
  string,
  text,
  textPiece,
  unbounded,
  type Value,
} from "./value.js";

import type { Lowering } from "./language.js";

function evaluate(target: TestNode, bindings?: Record<string, Value>): Value {
  const evaluator = new Evaluator(testLowering);
  const options =
    bindings === undefined
      ? {}
      : { bindings: new Map(Object.entries(bindings)) };
  return force(evaluator.evaluate(target, options));
}

function piecesOf(value: Value): readonly Piece[] {
  const forced = force(value);
  if (forced.kind !== "string") {
    throw new Error(`expected a string, got ${forced.kind}`);
  }
  return forced.pieces;
}

describe("Evaluator", () => {
  describe("strings", () => {
    it("folds a template over literal bindings", () => {
      const target = template("/users/", name("id"), "/posts");
      module([declare({ id: lit("42") }), expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/users/42/posts");
    });

    it("keeps a hole for a parameter, named after it", () => {
      const target = template("/users/", name("id"));
      module([fn(["id"], [ret(target)])]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["/users/"] },
        { kind: "hole", name: "id", range: "one" },
      ]);
    });

    it("takes a parameter value from the call site when given one", () => {
      const target = template("/users/", name("id"));
      module([fn(["id"], [ret(target)])]);
      expect(
        literalOf(
          evaluate(target, {
            id: { kind: "string", pieces: [{ kind: "text", options: ["7"] }] },
          }),
        ),
      ).toBe("/users/7");
    });

    it("folds concatenation and compound assignment", () => {
      const target = name("path");
      module([
        declare({ path: lit("/api") }),
        assign(name("path"), lit("/v1"), "+"),
        assign(name("path"), op("+", name("path"), lit("/users"))),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/api/v1/users");
    });
  });

  describe("branches", () => {
    it("joins the two values a name can have after an if", () => {
      const target = name("prefix");
      module([
        declare({ prefix: lit("/a") }),
        branch(name("flag"), [assign(name("prefix"), lit("/b"))], []),
        expr(target),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["/a", "/b"] },
      ]);
    });

    it("takes only the arm a literal condition selects", () => {
      const target = name("prefix");
      module([
        declare({ prefix: lit("/a") }),
        branch(lit(true), [assign(name("prefix"), lit("/b"))], []),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/b");
    });

    it("folds a conditional expression whose condition is settled", () => {
      const target = cond(
        op("===", name("mode"), lit("x")),
        lit("/x"),
        lit("/y"),
      );
      module([declare({ mode: lit("x") }), expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/x");
    });

    it("joins both sides of a conditional the source leaves open", () => {
      const target = cond(name("flag"), lit("/x"), lit("/y"));
      module([expr(target)]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["/x", "/y"] },
      ]);
    });

    it("reads the state inside the arm containing the target", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        branch(name("flag"), [assign(name("p"), lit("/b")), expr(target)], []),
      ]);
      expect(literalOf(evaluate(target))).toBe("/b");
    });

    it("ignores an arm that returns when joining", () => {
      const target = name("p");
      module([
        fn(
          [],
          [
            declare({ p: lit("/a") }),
            branch(
              name("flag"),
              [ret(lit(null))],
              [assign(name("p"), lit("/b"))],
            ),
            expr(target),
          ],
        ),
      ]);
      expect(literalOf(evaluate(target))).toBe("/b");
    });
  });

  describe("sequences", () => {
    it("sees a push through the heap and joins the parts", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("api")) }),
        expr(call(name("parts"), "push", [lit("users")])),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("api/users");
    });

    it("marks an element only one branch pushed as optional", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("api")) }),
        branch(
          name("flag"),
          [expr(call(name("parts"), "push", [lit("v1")]))],
          [],
        ),
        expr(target),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["api"] },
        { kind: "text", options: ["", "/v1"] },
      ]);
    });

    it("sees a push through an alias of the same array", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        declare({ p: name("parts") }),
        expr(call(name("p"), "push", [lit("b")])),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("a/b");
    });

    it("copies an array a row reads the content of", () => {
      const target = call(name("copy"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        declare({ extra: array(lit("b")) }),
        declare({ copy: call(name("parts"), "concat", [name("extra")]) }),
        expr(call(name("extra"), "push", [lit("c")])),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("a/b");
    });

    it("copies a spread array instead of aliasing it", () => {
      const target = call(name("copy"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        declare({ copy: array({ spread: name("parts") }, lit("b")) }),
        expr(call(name("parts"), "push", [lit("c")])),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("a/b");
    });

    it("widens an array a loop pushes into", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        loop([expr(call(name("parts"), "push", [lit("b")]))]),
        expr(target),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "hole", name: "value", range: "any" },
      ]);
    });

    it("reads an element by index and the length", () => {
      const first = element(name("parts"), lit(0));
      const length = member(name("parts"), "length");
      module([
        declare({ parts: array(lit("a"), lit("b")) }),
        expr(first),
        expr(length),
      ]);
      expect(literalOf(evaluate(first))).toBe("a");
      expect(force(evaluate(length))).toEqual({
        kind: "constant",
        options: [2],
      });
    });

    it("writes an element by index", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a"), lit("b")) }),
        assign(element(name("parts"), lit(1)), lit("c")),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("a/c");
    });
  });

  describe("records", () => {
    it("reads a field written after the literal", () => {
      const target = member(name("config"), "prefix");
      module([
        declare({ config: record({ prefix: lit("/a") }) }),
        assign(member(name("config"), "prefix"), lit("/b")),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/b");
    });

    it("spreads a known record and keeps a later field", () => {
      const target = member(name("merged"), "prefix");
      module([
        declare({ base: record({ prefix: lit("/a"), other: lit("x") }) }),
        declare({ merged: record([{ spread: name("base") }]) }),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });

    it("gives undefined for a field a closed record lacks", () => {
      const target = member(name("config"), "missing");
      module([
        declare({ config: record({ prefix: lit("/a") }) }),
        expr(target),
      ]);
      expect(force(evaluate(target))).toEqual({
        kind: "constant",
        options: [undefined],
      });
    });

    it("gives a hole for a field of a record spread from something unknown", () => {
      const target = member(name("config"), "missing");
      module([
        declare({ config: record([{ spread: name("unknown") }]) }),
        expr(target),
      ]);
      expect(force(evaluate(target))).toEqual({
        kind: "hole",
        name: "missing",
      });
    });
  });

  describe("escape", () => {
    it("forgets an array handed to a call it cannot see into", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        expr(call(null, "mutate", [name("parts")])),
        expr(target),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "hole", name: "value", range: "any" },
      ]);
    });

    it("forgets an array a callback handed to an unknown call closes over", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      const callback = fn([], [expr(call(name("parts"), "push", [lit("b")]))], {
        freeNames: ["parts"],
      });
      module([
        declare({ parts: array(lit("a")) }),
        expr(call(null, "later", [callback])),
        expr(target),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "hole", name: "value", range: "any" },
      ]);
    });

    it("forgets a string written to a field of something it cannot see", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        assign(member(name("unknown"), "path"), name("p")),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });
  });

  describe("calls", () => {
    it("inlines a project function and joins its returns", () => {
      const helper = fn(
        ["flag"],
        [branch(name("flag"), [ret(lit("/x"))], []), ret(lit("/y"))],
      );
      const target = call(null, "helper", [name("input")], { calls: helper });
      module([helper, expr(target)]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["/x", "/y"] },
      ]);
    });

    it("inlines a function that pushes into an array it was given", () => {
      const helper = fn(
        ["list"],
        [expr(call(name("list"), "push", [lit("b")]))],
      );
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        helper,
        declare({ parts: array(lit("a")) }),
        expr(call(null, "helper", [name("parts")], { calls: helper })),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("a/b");
    });

    it("inlines an expression-bodied function", () => {
      const helper = fn(["a", "b"], op("+", name("a"), name("b")));
      const target = call(null, "helper", [lit("/a"), lit("/b")], {
        calls: helper,
      });
      module([helper, expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/a/b");
    });

    it("takes a parameter default when the call leaves it out", () => {
      const helper = fn(
        ["a", parameter("b", lit("/v1"))],
        op("+", name("a"), name("b")),
      );
      const short = call(null, "helper", [lit("/api")], { calls: helper });
      const full = call(null, "helper", [lit("/api"), lit("/v2")], {
        calls: helper,
      });
      module([helper, expr(short), expr(full)]);
      expect(literalOf(evaluate(short))).toBe("/api/v1");
      expect(literalOf(evaluate(full))).toBe("/api/v2");
    });

    it("reads a default from a constant above and from an earlier parameter", () => {
      const helper = fn(
        ["a", parameter("b", name("SUFFIX")), parameter("c", name("b"))],
        op("+", name("a"), name("c")),
      );
      const target = call(null, "helper", [lit("/api")], { calls: helper });
      module([declare({ SUFFIX: lit("/x") }), helper, expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/api/x");
    });

    it("binds a keyword argument by name ahead of position", () => {
      const helper = fn(
        ["a", parameter("b", lit("/v1")), parameter("c", lit("/z"))],
        op("+", op("+", name("a"), name("b")), name("c")),
      );
      const target = call(
        null,
        "helper",
        [lit("/api"), { named: "c", node: lit("/y") }],
        { calls: helper },
      );
      module([helper, expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/api/v1/y");
    });

    it("loses an array handed to an unknown call by keyword", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        expr(call(null, "register", [{ named: "items", node: name("parts") }])),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBeNull();
    });

    it("refuses to inline a function with a loop", () => {
      const helper = fn(
        ["list"],
        [loop([expr(call(name("list"), "push", [lit("b")]))])],
      );
      const target = call(null, "helper", [lit("x")], { calls: helper });
      module([helper, expr(target)]);
      expect(force(evaluate(target))).toEqual({ kind: "hole", name: "param" });
    });

    it("stops inlining past the depth cap", () => {
      const inner = fn([], [ret(lit("/deep"))]);
      const middle = fn([], [ret(call(null, "inner", [], { calls: inner }))]);
      const outer = fn([], [ret(call(null, "middle", [], { calls: middle }))]);
      const target = call(null, "outer", [], { calls: outer });
      module([inner, middle, outer, expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/deep");

      const deeper = fn([], [ret(call(null, "outer", [], { calls: outer }))]);
      const tooDeep = call(null, "deeper", [], { calls: deeper });
      module([inner, middle, outer, deeper, expr(tooDeep)]);
      expect(force(evaluate(tooDeep))).toEqual({ kind: "hole", name: "param" });
    });

    it("applies a callee row by import origin", () => {
      const target = call(null, "join", [lit("/a"), lit("b")], {
        origin: { module: "path", name: "join" },
      });
      module([expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/a/b");
    });

    it("spreads a known array into the arguments", () => {
      const target = call(null, "join", [{ spread: name("parts") }], {
        origin: { module: "path", name: "join" },
      });
      module([declare({ parts: array(lit("/a"), lit("b")) }), expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/a/b");
    });

    it("gives a hole named after the call when nothing covers it", () => {
      const target = call(null, "mystery", []);
      module([expr(target)]);
      expect(force(evaluate(target))).toEqual({ kind: "hole", name: "param" });
    });
  });

  describe("outer names", () => {
    it("reads a module constant from inside a function", () => {
      const target = template(name("base"), "/users");
      module([declare({ base: lit("/api") }), fn([], [ret(target)])]);
      expect(literalOf(evaluate(target))).toBe("/api/users");
    });

    it("reads a module array from inside a function through its rows", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a"), lit("b")) }),
        fn([], [ret(target)]),
      ]);
      expect(literalOf(evaluate(target))).toBe("a/b");
    });

    it("reads the module state at the point the function is written", () => {
      const target = name("base");
      module([
        declare({ base: lit("/a") }),
        fn([], [ret(target)]),
        assign(name("base"), lit("/b")),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });

    it("widens a module array a nested function pushes into", () => {
      const target = call(name("parts"), "join", [lit("/")]);
      const root = module([
        declare({ parts: array(lit("a")) }),
        fn([], [ret(target)]),
      ]);
      root.mutatedNames = ["parts"];
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "hole", name: "value", range: "any" },
      ]);
    });

    it("follows a name to the expression it was written as", () => {
      const written = lit("/elsewhere");
      module([expr(written)]);
      const target = name("base", written);
      module([expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/elsewhere");
    });

    it("reads a call it cannot inline as what the call was written to", () => {
      const passedThrough = lit("/p");
      const target = call(null, "wrap", [passedThrough]);
      target.writtenTo = passedThrough;
      module([expr(target)]);
      expect(literalOf(evaluate(target))).toBe("/p");
    });

    it("keeps an array handed to a call it can follow", () => {
      const parts = name("parts");
      const wrapped = call(null, "wrap", [parts]);
      wrapped.writtenTo = lit("/p");
      const target = call(name("parts"), "join", [lit("/")]);
      module([
        declare({ parts: array(lit("a")) }),
        expr(wrapped),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("a");
    });

    it("gives a hole for a name that resolves to itself", () => {
      const target = name("base");
      target.writtenTo = target;
      module([expr(target)]);
      expect(force(evaluate(target))).toEqual({ kind: "hole", name: "base" });
    });

    it("gives a hole for names that resolve to each other", () => {
      const a = name("a");
      const b = name("b", a);
      a.writtenTo = b;
      module([expr(a), expr(b)]);
      expect(force(evaluate(a))).toEqual({ kind: "hole", name: "a" });
    });

    it("reads an element of an array a name was written to elsewhere", () => {
      const elsewhere = array(lit("a"), lit("b"));
      module([expr(elsewhere)]);
      const target = element(name("items", elsewhere), lit(1));
      module([expr(target)]);
      expect(literalOf(evaluate(target))).toBe("b");
    });

    it("reads a field of a record declared at module level", () => {
      const target = member(name("config"), "prefix");
      module([
        declare({ config: record({ prefix: lit("/a") }) }),
        fn([], [ret(target)]),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });
  });

  describe("loops and blocks", () => {
    it("keeps a string a loop does not change", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        loop([expr(call(null, "noop"))]),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });

    it("widens a string a loop appends to", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        loop([assign(name("p"), lit("/b"), "+")]),
        expr(target),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["/a"] },
        { kind: "hole", name: "value", range: "any" },
      ]);
    });

    it("reads a target inside a loop body after one pass", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        loop([expr(target), assign(name("p"), lit("/b"), "+")]),
      ]);
      expect(piecesOf(evaluate(target))).toEqual([
        { kind: "text", options: ["/a"] },
        { kind: "hole", name: "value", range: "any" },
      ]);
    });

    it("runs into a block", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        block([assign(name("p"), lit("/b")), expr(target)]),
      ]);
      expect(literalOf(evaluate(target))).toBe("/b");
    });

    it("gives a hole for a statement it does not understand", () => {
      const target = name("p");
      module([declare({ p: null }), opaque(), expr(target)]);
      expect(force(evaluate(target))).toEqual({ kind: "hole", name: "p" });
    });
  });

  describe("memo", () => {
    it("answers many targets in one module without rerunning from the top", () => {
      const first = name("p");
      const second = name("p");
      module([
        declare({ p: lit("/a") }),
        expr(first),
        assign(name("p"), lit("/b")),
        expr(second),
      ]);
      const evaluator = new Evaluator(testLowering);
      expect(literalOf(force(evaluator.evaluate(first)))).toBe("/a");
      expect(literalOf(force(evaluator.evaluate(second)))).toBe("/b");
      expect(literalOf(force(evaluator.evaluate(first)))).toBe("/a");
    });

    it("resolves a call it cannot inline once, however often its function is inlined", () => {
      let resolved = 0;
      const wrapped = call(null, "wrap", [name("a")]);
      const helper = fn(["a"], wrapped);
      const target = op(
        "+",
        call(null, "helper", [lit("/x")], { calls: helper }),
        call(null, "helper", [lit("/y")], { calls: helper }),
      );
      module([helper, expr(target)]);
      const counting: Lowering<TestNode> = {
        ...testLowering,
        writtenTo: (n) => {
          if (n === wrapped) {
            resolved += 1;
            return lit("/p");
          }
          return testLowering.writtenTo(n);
        },
      };
      const evaluator = new Evaluator(counting);
      expect(literalOf(force(evaluator.evaluate(target)))).toBe("/p/p");
      expect(resolved).toBe(1);
    });
  });

  describe("limits", () => {
    it("stops running statements past the budget", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        assign(name("p"), lit("/b")),
        assign(name("p"), lit("/c")),
        expr(target),
      ]);
      const evaluator = new Evaluator(testLowering, { statementBudget: 1 });
      expect(literalOf(force(evaluator.evaluate(target)))).toBe("/a");
    });

    it("stops at a return before the target", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        ret(null),
        assign(name("p"), lit("/b")),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });

    it("keeps the state when every arm returns", () => {
      const target = name("p");
      module([
        fn(
          [],
          [
            declare({ p: lit("/a") }),
            branch(name("flag"), [ret(lit(1))], [ret(lit(2))]),
            expr(target),
          ],
        ),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });

    it("runs a block before the target and reads inside a false arm", () => {
      const target = name("p");
      module([
        declare({ p: lit("/a") }),
        block([assign(name("p"), lit("/b"))]),
        branch(lit(false), [expr(lit(0))], [expr(target)]),
      ]);
      expect(literalOf(evaluate(target))).toBe("/b");
    });

    it("gives an unnamed hole for an expression outside any module", () => {
      expect(evaluate(name("p"))).toEqual({ kind: "hole", name: "p" });
      expect(evaluate(op("*", lit(1), lit(2)))).toEqual({
        kind: "hole",
        name: "value",
      });
    });
  });

  describe("heap edges", () => {
    it("opens a record written at an index nothing settled", () => {
      const target = member(name("config"), "prefix");
      module([
        fn(
          ["key"],
          [
            declare({ config: record({ base: lit("/a") }) }),
            assign(element(name("config"), name("key")), lit("/x")),
            expr(target),
          ],
        ),
      ]);
      expect(evaluate(target)).toEqual({ kind: "hole", name: "prefix" });
    });

    it("reads a field through a literal key held in a name", () => {
      const target = element(name("config"), name("key"));
      module([
        declare({ key: lit("base"), config: record({ base: lit("/a") }) }),
        expr(target),
      ]);
      expect(literalOf(evaluate(target))).toBe("/a");
    });

    it("keeps a computed field with a literal key and opens the record otherwise", () => {
      const known = member(name("config"), "base");
      const unknown = member(name("config"), "other");
      module([
        fn(
          ["key"],
          [
            declare({
              config: computedRecord([
                [lit("base"), lit("/a")],
                [name("key"), lit("/b")],
              ]),
            }),
            expr(known),
            expr(unknown),
          ],
        ),
      ]);
      expect(literalOf(evaluate(known))).toBe("/a");
      expect(evaluate(unknown)).toEqual({ kind: "hole", name: "other" });
    });

    it("widens a sequence written past its end or through an unknown index", () => {
      const pastEnd = name("parts");
      const unknownIndex = name("more");
      module([
        fn(
          ["i"],
          [
            declare({ parts: array(lit("a")), more: array(lit("a")) }),
            assign(element(name("parts"), lit(5)), lit("b")),
            assign(element(name("more"), name("i")), lit("b")),
            assign(element(name("more"), lit(0)), lit("c")),
            expr(pastEnd),
            expr(unknownIndex),
          ],
        ),
      ]);
      expect(evaluate(pastEnd)).toEqual(
        unbounded(string([textPiece(["a", "b"])])),
      );
      expect(evaluate(unknownIndex)).toEqual(
        unbounded(string([textPiece(["a", "b", "c"])])),
      );
    });

    it("writes an element in place", () => {
      const target = name("parts");
      module([
        declare({ parts: array(lit("a"), lit("b")) }),
        assign(element(name("parts"), lit(1)), lit("c")),
        expr(target),
      ]);
      expect(evaluate(target)).toEqual(sequence([text("a"), text("c")]));
    });

    it("lets a write through something that is not an allocation escape the value", () => {
      const target = name("parts");
      module([
        fn(
          ["other"],
          [
            declare({ parts: array(lit("a")) }),
            assign(member(name("other"), "items"), name("parts")),
            expr(target),
          ],
        ),
      ]);
      expect(evaluate(target)).toEqual(unbounded(hole("value")));
    });

    it("lets a write to a target it cannot name escape the value", () => {
      const target = name("parts");
      module([
        declare({ parts: array(lit("a")) }),
        assign(opaque(), name("parts")),
        expr(target),
      ]);
      expect(evaluate(target)).toEqual(unbounded(hole("value")));
    });

    it("spreads an unbounded array and a non-array into an unbounded one", () => {
      const fromUnbounded = array(lit("x"), { spread: name("grown") });
      const fromUnknown = array({ spread: name("thing") }, lit("y"));
      module([
        fn(
          ["thing"],
          [
            declare({ grown: array(lit("a")) }),
            loop([expr(call(name("grown"), "push", [lit("b")]))]),
            expr(fromUnbounded),
            expr(fromUnknown),
          ],
        ),
      ]);
      expect(evaluate(fromUnbounded)).toEqual(
        unbounded(string([textPiece(["a", "b", "x"])])),
      );
      expect(evaluate(fromUnknown)).toEqual(unbounded(hole("value")));
    });

    it("reads an element of an unbounded array and gives a hole for a field of a string", () => {
      const element0 = element(name("grown"), lit(0));
      const field = member(name("s"), "size");
      module([
        declare({ grown: array(lit("a")), s: lit("x") }),
        loop([expr(call(name("grown"), "push", [lit("b")]))]),
        expr(element0),
        expr(field),
      ]);
      expect(evaluate(element0)).toEqual(string([textPiece(["a", "b"])]));
      expect(evaluate(field)).toEqual({ kind: "hole", name: "size" });
    });

    it("gives a hole for a record that contains itself", () => {
      const target = name("o");
      module([
        declare({ o: record({ base: lit("/a") }) }),
        assign(member(name("o"), "self"), name("o")),
        expr(target),
      ]);
      const value = evaluate(target);
      expect(
        value.kind === "record" && value.fields.get("self")?.value,
      ).toEqual(hole("value"));
    });

    it("keeps an allocation made in only one arm", () => {
      const target = name("x");
      module([
        fn(
          ["flag"],
          [
            declare({ x: lit("a") }),
            branch(name("flag"), [declare({ y: array(lit("a")) })], []),
            expr(target),
          ],
        ),
      ]);
      expect(literalOf(evaluate(target))).toBe("a");
    });

    it("widens a record and a string that a nested function mutates", () => {
      const field = member(name("config"), "base");
      const prefix = name("prefix");
      const inner = fn([], [expr(field), expr(prefix)]);
      module([
        declare({
          config: record({ base: lit("/a") }),
          prefix: lit("/p"),
        }),
        inner,
      ]).mutatedNames = ["config", "prefix"];
      expect(evaluate(field)).toEqual({ kind: "hole", name: "base" });
      expect(evaluate(prefix)).toEqual({ kind: "hole", name: "prefix" });
    });

    it("widens a name in its own scope once a nested function writes it", () => {
      const declared = name("prefix");
      const assigned = name("prefix");
      module([
        declare({ prefix: lit("/p") }),
        expr(declared),
        assign(name("prefix"), lit("/q")),
        expr(assigned),
        fn([], []),
      ]).mutatedNames = ["prefix"];
      expect(evaluate(declared)).toEqual({ kind: "hole", name: "prefix" });
      expect(evaluate(assigned)).toEqual({ kind: "hole", name: "prefix" });
    });
  });

  describe("call edges", () => {
    it("spreads a known array into the arguments and a hole for anything else", () => {
      const known = call(null, "join", [{ spread: name("parts") }], {
        origin: { module: "path", name: "join" },
      });
      const unknown = call(null, "join", [{ spread: name("thing") }], {
        origin: { module: "path", name: "join" },
      });
      module([
        fn(
          ["thing"],
          [
            declare({ parts: array(lit("a"), lit("b")) }),
            expr(known),
            expr(unknown),
          ],
        ),
      ]);
      expect(literalOf(evaluate(known))).toBe("a/b");
      expect(evaluate(unknown)).toEqual(string([holePiece("value")]));
    });

    it("ignores a callee row from another module and a call with no name", () => {
      const other = call(null, "join", [lit("a")], {
        origin: { module: "other", name: "join" },
      });
      const unnamed = call(null, null, [lit("a")]);
      module([expr(other), expr(unnamed)]);
      expect(evaluate(other)).toEqual({ kind: "hole", name: "param" });
      expect(evaluate(unnamed)).toEqual({ kind: "hole", name: "param" });
    });

    it("returns the receiver when a row says so", () => {
      const sorted = call(name("parts"), "sort");
      const same = call(name("parts"), "same", [], {
        origin: { module: "lib", name: "same" },
      });
      const bare = call(null, "same", [], {
        origin: { module: "lib", name: "same" },
      });
      module([
        declare({ parts: array(lit("a")) }),
        expr(sorted),
        expr(same),
        expr(bare),
      ]);
      expect(evaluate(sorted)).toEqual(sequence([text("a")]));
      expect(evaluate(same)).toEqual(sequence([text("a")]));
      expect(evaluate(bare)).toEqual(hole("value"));
    });

    it("matches a constructor call only to a row that constructs", () => {
      const built = call(null, "Box", [lit("a")], {
        origin: { module: "lib", name: "Box" },
        constructs: true,
      });
      const called = call(null, "Box", [lit("a")], {
        origin: { module: "lib", name: "Box" },
      });
      module([expr(built), expr(called)]);
      expect(literalOf(evaluate(built))).toBe("a");
      expect(evaluate(called)).toEqual({ kind: "hole", name: "param" });
    });

    it("refuses to inline a helper with a loop inside a block", () => {
      const helper = fn(["p"], [block([loop([expr(lit(0))])]), ret(name("p"))]);
      const target = call(null, "helper", [lit("/a")], { calls: helper });
      module([helper, expr(target)]);
      expect(evaluate(target)).toEqual({ kind: "hole", name: "param" });
    });

    it("leaves a callback free name alone when it is not bound here", () => {
      const target = name("parts");
      const callback = fn([], [], { freeNames: ["nothing"] });
      module([
        declare({ parts: array(lit("a")) }),
        expr(call(null, "each", [callback])),
        expr(target),
      ]);
      expect(evaluate(target)).toEqual(sequence([text("a")]));
    });
  });

  describe("resolution edges", () => {
    it("gives a hole for two members written as each other", () => {
      const first = member(name("a"), "p");
      const second = member(name("b"), "p");
      first.writtenTo = second;
      second.writtenTo = first;
      expect(evaluate(first)).toEqual({ kind: "hole", name: "p" });
    });

    it("names a hole after the name it is bound to", () => {
      const bound = template("/x/", name("p"));
      const written = name("q");
      written.writtenTo = call(null, "compute");
      module([
        declare({ p: call(null, "compute") }),
        assign(name("p"), call(null, "other")),
        expr(bound),
      ]);
      expect(piecesOf(evaluate(bound))).toEqual([
        textPiece(["/x/"]),
        holePiece("p"),
      ]);
      expect(evaluate(written)).toEqual({ kind: "hole", name: "q" });
    });

    it("gives a hole for a name written as itself", () => {
      const self = name("a");
      self.writtenTo = self;
      expect(evaluate(self)).toEqual({ kind: "hole", name: "a" });
    });

    it("reads an unfilled parameter through what its use was written as", () => {
      const use = name("route", lit("/users"));
      module([expr(fn(["route"], [ret(use)]))]);
      expect(evaluate(use)).toEqual(text("/users"));
    });

    it("does not read an outer name in place of an unfilled parameter", () => {
      const use = name("route");
      const inner = fn([], [ret(use)]);
      module([
        declare({ route: lit("/outer") }),
        expr(fn(["route"], [ret(inner)])),
      ]);
      expect(evaluate(use)).toEqual({ kind: "hole", name: "route" });
    });

    it("reads a parameter written over inside the function", () => {
      const use = name("route");
      module([
        expr(fn(["route"], [assign(name("route"), lit("/x"), "+"), ret(use)])),
      ]);
      expect(piecesOf(evaluate(use))).toEqual([
        holePiece("route"),
        textPiece(["/x"]),
      ]);
    });
  });

  describe("a lowering whose nodes are fresh objects on every read", () => {
    type Copied = TestNode & { id?: number };
    const ids = new Map<TestNode, number>();
    const idOf = (n: Copied): number => {
      if (n.id !== undefined) {
        return n.id;
      }
      const known = ids.get(n);
      if (known !== undefined) {
        return known;
      }
      ids.set(n, ids.size + 1);
      return ids.size;
    };
    const copy = (n: TestNode): Copied => ({ ...n, id: idOf(n) });
    const copying: Lowering<TestNode> = {
      ...testLowering,
      statement: (n) => {
        const shape = testLowering.statement(n);
        return shape.kind === "branch"
          ? { ...shape, arms: shape.arms.map((arm) => arm.map(copy)) }
          : shape;
      },
      siteOf: (n) => {
        const site = testLowering.siteOf(n);
        return site === null
          ? null
          : { root: copy(site.root), path: site.path.map(copy) };
      },
      functionOf: (n) => {
        const shape = testLowering.functionOf(n);
        return shape === null || !Array.isArray(shape.body)
          ? shape
          : { ...shape, body: shape.body.map(copy) };
      },
      writtenTo: (n) => {
        const written = testLowering.writtenTo(n);
        return written === null ? null : copy(written);
      },
      idOf,
    };

    it("finds the statement path, the memo and a write by id", () => {
      const evaluator = new Evaluator(copying);
      const inArm = op("+", name("x"), lit("/b"));
      const written = name("y", lit("/c"));
      module([
        declare({ x: lit("/a") }),
        branch(name("flag"), [expr(inArm)], []),
        expr(written),
      ]);
      expect(literalOf(force(evaluator.evaluate(inArm)))).toBe("/a/b");
      expect(literalOf(force(evaluator.evaluate(inArm)))).toBe("/a/b");
      expect(literalOf(force(evaluator.evaluate(written)))).toBe("/c");
    });
  });
});
