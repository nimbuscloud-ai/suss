/**
 * Direct coverage of the generic path engine against StructuredStatement
 * trees built by hand. No language adapter is involved, so these tests pin
 * down what a lowering can rely on, whatever ts-morph or some later
 * language's lowering happens to produce. The TypeScript adapter's own
 * pathConditions tests cover the same behaviour end to end.
 */

import { describe, expect, it } from "vitest";

import {
  enumerateOrDegrade,
  enumerateStructuredPaths,
  PathBudgetExceeded,
  UnmodeledFlow,
} from "./enumeratePaths.js";

import type {
  CaseGroup,
  ConditionHandle,
  ConditionInfo,
  ExitKind,
  StructuredStatement,
} from "./structuredStatement.js";

type S = StructuredStatement<string>;

// ---------------------------------------------------------------------------
// Fixture builders. Cond is `string`, a condition's display text, which the
// engine never looks inside. Terminal is `string` too, an id this test picks.
// The exitKind on an if, switch, loop, or try comes from the children the same
// way a lowering's own deep scan would work it out, so the fixtures stay
// consistent without anyone tracking it by hand at every call site.
// ---------------------------------------------------------------------------

const cond = (sourceText: string): ConditionHandle<string> => ({
  sourceText,
  expression: null,
});

const ret = (): S => ({ kind: "exit", exit: "return", exitKind: "return" });
const thr = (): S => ({ kind: "exit", exit: "throw", exitKind: "throw" });
const brk = (): S => ({ kind: "exit", exit: "break", exitKind: null });
const opq = (): S => ({ kind: "opaque", exitKind: null });

function combineExit(a: ExitKind, b: ExitKind): ExitKind {
  if (a === "throw" || b === "throw") {
    return "throw";
  }
  if (a === "return" || b === "return") {
    return "return";
  }
  return null;
}

function exitOfList(stmts: readonly S[]): ExitKind {
  return stmts.reduce<ExitKind>((acc, s) => combineExit(acc, s.exitKind), null);
}

function mkIf(
  condition: ConditionHandle<string>,
  thenBody: S[],
  elseBody: S[] | null,
): S {
  return {
    kind: "if",
    condition,
    thenBody,
    elseBody,
    exitKind: combineExit(
      exitOfList(thenBody),
      elseBody === null ? null : exitOfList(elseBody),
    ),
  };
}

function mkLoop(headerText: string, body: S[]): S {
  return {
    kind: "loop",
    condition: cond(headerText),
    body,
    exitKind: exitOfList(body),
  };
}

function mkTry(
  tryBody: S[],
  catchBody: S[] | null,
  finallyBody: S[] | null,
): S {
  return {
    kind: "try",
    tryBody,
    catchBody,
    finallyBody,
    exitKind: combineExit(
      exitOfList(tryBody),
      catchBody === null ? null : exitOfList(catchBody),
    ),
  };
}

function mkSwitch(groups: CaseGroup<string>[]): S {
  return {
    kind: "switch",
    groups,
    exitKind: groups.reduce<ExitKind>(
      (acc, g) => combineExit(acc, exitOfList(g.body)),
      null,
    ),
  };
}

function group(
  sourceText: string | null,
  hasTrailingBreak: boolean,
  body: S[],
): CaseGroup<string> {
  return {
    condition: sourceText === null ? null : { sourceText, expression: null },
    hasTrailingBreak,
    body,
  };
}

const sig = (infos: ConditionInfo<string>[]): string =>
  infos.map((c) => `${c.polarity}:${c.source}:${c.sourceText}`).join(" ∧ ") ||
  "<unconditional>";

const pathSigs = (paths: ConditionInfo<string>[][] | undefined): string[] =>
  (paths ?? []).map(sig).sort();

// ---------------------------------------------------------------------------

describe("enumerateStructuredPaths, if/else", () => {
  it("guard chain: guards accumulate as negated early returns", () => {
    const t0 = ret();
    const t1 = ret();
    const t2 = ret();
    const statements = [
      mkIf(cond("!a"), [t0], null),
      mkIf(cond("!b"), [t1], null),
      t2,
    ];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
      [t2, ["T2"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "positive:explicit:!a",
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      "negative:earlyReturn:!a ∧ positive:explicit:!b",
    ]);
    expect(pathSigs(result.byTerminal.get("T2"))).toEqual([
      "negative:earlyReturn:!a ∧ negative:earlyReturn:!b",
    ]);
  });

  it("non-exit non-terminal ifs collapse: no path split", () => {
    const log = opq();
    const t0 = ret();
    const statements = [mkIf(cond("a"), [log], null), t0];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
  });

  it("nested guard: the fallthrough gets one branch per real path", () => {
    const t0 = ret(); // if (a) { if (b) { return } }
    const t1 = ret(); // return (after the outer if)
    const inner = mkIf(cond("b"), [t0], null);
    const outer = mkIf(cond("a"), [inner], null);
    const statements = [outer, t1];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "positive:explicit:a ∧ positive:explicit:b",
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      "negative:earlyReturn:a",
      "positive:explicit:a ∧ negative:earlyReturn:b",
    ]);
  });

  it("else-exit: statements after the if are gated on the then branch", () => {
    const log = opq();
    const t0 = ret(); // else { return }
    const t1 = ret(); // return (after the if)
    const statements = [mkIf(cond("a"), [log], [t0]), t1];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      "positive:explicit:a",
    ]);
  });

  it("a negative condition enclosing the terminal (an else arm) stays explicit, not earlyReturn", () => {
    const log = opq(); // then arm holds something, so the if doesn't collapse
    const t0 = ret(); // else { return } - the terminal sits inside this if
    const statements = [mkIf(cond("a"), [log], [t0])];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "negative:explicit:a",
    ]);
  });

  it("dead code after an unconditional exit gets no entry", () => {
    const t0 = ret();
    const t1 = ret(); // unreachable
    const statements = [t0, t1];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
    expect(result.byTerminal.has("T1")).toBe(false);
  });

  it("fallthrough paths carry the guards they passed", () => {
    const t0 = ret();
    const log = opq();
    const statements = [mkIf(cond("!a"), [t0], null), log];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(result.fallthrough.map(sig)).toEqual(["negative:earlyReturn:!a"]);
  });

  it("a throw further down a multi-statement arm still wins the arm's exit kind", () => {
    // The then-arm's own exit kind comes from scanning every statement
    // in it, not only the first one: a throw anywhere in the arm wins
    // over a return anywhere else in it, which is what tells the
    // terminal after a passed guard that it arrived by an earlyThrow.
    const log = opq();
    const t0 = ret(); // after the if
    const statements = [mkIf(cond("a"), [log, thr()], null), t0];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "negative:earlyThrow:a",
    ]);
  });
});

describe("enumerateStructuredPaths, loops", () => {
  it("loop exits: in-loop terminals and the fallthrough both opacify", () => {
    const t0 = ret(); // for (...) { if (!q) { return } }
    const t1 = ret(); // return (after the loop)
    const guarded = mkIf(cond("!q"), [t0], null);
    const statements = [mkLoop("for (const key of keys)", [guarded]), t1];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    const inLoop = pathSigs(result.byTerminal.get("T0"));
    expect(inLoop).toHaveLength(1);
    expect(inLoop[0]).toContain("some iteration of:");
    expect(inLoop[0]).toContain("positive:explicit:!q");

    const afterLoop = pathSigs(result.byTerminal.get("T1"));
    expect(afterLoop).toHaveLength(1);
    expect(afterLoop[0]).toContain(
      "negative:earlyReturn:loop exited via return:",
    );
  });

  it("loops without exits add no conditions to the fallthrough", () => {
    const log = opq();
    const t0 = ret();
    const statements = [mkLoop("for (const key of keys)", [log]), t0];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
  });

  it("a loop break leaves the after-loop terminal clean", () => {
    const guarded = mkIf(cond('item === "stop"'), [brk()], null);
    const t0 = ret();
    const statements = [mkLoop("for (const item of items)", [guarded]), t0];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
  });
});

describe("enumerateStructuredPaths, try/catch/finally", () => {
  it("catch terminals carry the catch condition; rethrows too", () => {
    const t0 = thr(); // catch (err) { throw err }
    const statements = [mkTry([ret()], [t0], null)];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "positive:catchBlock:catch",
    ]);
  });

  it("a catch that falls through splits the after-try terminal per route", () => {
    const log1 = opq();
    const log2 = opq();
    const t0 = ret();
    const statements = [mkTry([log1], [log2], null), t0];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "<unconditional>",
      "positive:catchBlock:catch",
    ]);
  });

  it("guards inside a catch compose with the catch condition", () => {
    const t0 = ret(); // if (isFatal(err)) { return 500 }
    const t1 = ret(); // return 502, a sibling after the if, no else
    const t2 = ret(); // return 200 (after the try)
    const guarded = mkIf(cond("isFatal(err)"), [t0], null);
    const statements = [mkTry([opq()], [guarded, t1], null), t2];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
      [t2, ["T2"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "positive:catchBlock:catch ∧ positive:explicit:isFatal(err)",
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      "positive:catchBlock:catch ∧ negative:earlyReturn:isFatal(err)",
    ]);
    expect(pathSigs(result.byTerminal.get("T2"))).toEqual(["<unconditional>"]);
  });

  it("allows a pure-cleanup finally as a pass-through", () => {
    const t0 = ret();
    const statements = [mkTry([t0], null, [opq()])];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
  });

  it("degrades on a finally that exits", () => {
    const statements = [mkTry([ret()], null, [ret()])];
    expect(() =>
      enumerateStructuredPaths({ statements, terminalsByStmt: new Map() }),
    ).toThrow(UnmodeledFlow);
  });

  it("degrades on a finally holding a caller-given terminal", () => {
    const t0 = opq(); // not an exit, but the caller cares about it
    const statements = [mkTry([ret()], null, [t0])];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    expect(() =>
      enumerateStructuredPaths({ statements, terminalsByStmt }),
    ).toThrow(UnmodeledFlow);
  });
});

describe("enumerateStructuredPaths, switch", () => {
  it("case groups carry the group's own condition; negations accumulate after", () => {
    const t0 = ret();
    const t1 = ret();
    const t2 = ret();
    const statements = [
      mkSwitch([
        group('kind === "a"', false, [t0]),
        group('kind === "b" || kind === "c"', false, [t1]),
      ]),
      t2,
    ];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
      [t2, ["T2"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      'positive:explicit:kind === "a"',
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      'positive:explicit:kind === "b" || kind === "c"',
    ]);
    expect(pathSigs(result.byTerminal.get("T2"))).toEqual([
      'negative:earlyReturn:kind === "a" ∧ negative:earlyReturn:kind === "b" || kind === "c"',
    ]);
  });

  it("trailing-break bodies join after the switch", () => {
    const log = opq();
    const t0 = ret(); // default: return 400
    const t1 = ret(); // return 200 (after the switch)
    const statements = [
      mkSwitch([group('kind === "a"', true, [log]), group(null, false, [t0])]),
      t1,
    ];
    const terminalsByStmt = new Map<S, string[]>([
      [t0, ["T0"]],
      [t1, ["T1"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      'negative:explicit:kind === "a"',
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      'positive:explicit:kind === "a"',
    ]);
  });

  it("degrades on fallthrough into a non-empty clause", () => {
    const log = opq();
    const t0 = ret();
    const statements = [
      mkSwitch([
        group('kind === "a"', false, [log]),
        group('kind === "b"', false, [t0]),
      ]),
    ];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    expect(() =>
      enumerateStructuredPaths({ statements, terminalsByStmt }),
    ).toThrow(UnmodeledFlow);
  });

  it("degrades on a non-trailing break", () => {
    const guarded = mkIf(cond("x"), [brk()], null);
    const t0 = ret();
    const statements = [
      mkSwitch([group('kind === "a"', false, [guarded, t0])]),
    ];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    expect(() =>
      enumerateStructuredPaths({ statements, terminalsByStmt }),
    ).toThrow(UnmodeledFlow);
  });

  it("a break inside a nested loop belongs to that loop, not the switch clause", () => {
    // The nested loop's own break does not have to be the last thing in the
    // switch clause containing it. It never reaches the switch at all.
    const t0 = ret();
    const nestedLoop = mkLoop("for (const x of xs)", [brk()]);
    const statements = [
      mkSwitch([group('kind === "a"', false, [nestedLoop, t0])]),
    ];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      'positive:explicit:kind === "a"',
    ]);
  });

  it("degrades on a break sitting in a group's own body, even when hasTrailingBreak says false", () => {
    // A lowering that reports hasTrailingBreak: false must still put a
    // break it finds into the group's own body for the engine to see,
    // not drop it (a block-wrapped `case "a": { const tag = f(); break; }`
    // unwraps this way: the break was never the clause's own top-level
    // last statement, so hasTrailingBreak is false, but it still ends up
    // as the last node of `body`). The engine's own stray-break scan is
    // what has to catch this, whatever a lowering hands it.
    const statements = [
      mkSwitch([group('kind === "a"', false, [opq(), brk()])]),
    ];

    expect(() =>
      enumerateStructuredPaths({ statements, terminalsByStmt: new Map() }),
    ).toThrow(UnmodeledFlow);
  });

  it("degrades the same way whether the group is last or has a group after it", () => {
    const withFollowingGroup = [
      mkSwitch([
        group('kind === "a"', false, [opq(), brk()]),
        group(null, false, [ret()]),
      ]),
    ];
    const withoutFollowingGroup = [
      mkSwitch([group('kind === "a"', false, [opq(), brk()])]),
    ];

    let lastReason: string | null = null;
    let onlyReason: string | null = null;
    try {
      enumerateStructuredPaths({
        statements: withFollowingGroup,
        terminalsByStmt: new Map(),
      });
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
    try {
      enumerateStructuredPaths({
        statements: withoutFollowingGroup,
        terminalsByStmt: new Map(),
      });
    } catch (err) {
      onlyReason = err instanceof Error ? err.message : String(err);
    }

    expect(lastReason).toBe("non-trailing break in switch clause");
    expect(onlyReason).toBe("non-trailing break in switch clause");
  });
});

describe("enumerateStructuredPaths, path budget", () => {
  it("stays at one path across a run of branches that all rejoin", () => {
    // Nine ifs in a row, both arms of each containing a terminal that does
    // not exit. Reaching what follows did not depend on any of them, so the
    // nine merge away instead of doubling the frontier to 2^9.
    const last = opq();
    let statements: S[] = [last];
    for (let i = 0; i < 9; i++) {
      statements = [mkIf(cond(`a${i}`), [opq()], [opq()]), ...statements];
    }
    const terminalsByStmt = new Map<S, string[]>();
    let id = 0;
    const registerLeaves = (nodes: readonly S[]): void => {
      for (const node of nodes) {
        if (node.kind === "if") {
          registerLeaves(node.thenBody);
          if (node.elseBody !== null) {
            registerLeaves(node.elseBody);
          }
        } else if (node.kind === "opaque") {
          terminalsByStmt.set(node, [`T${id++}`]);
        }
      }
    };
    registerLeaves(statements);
    terminalsByStmt.set(last, ["LAST"]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    // Each arm's own terminal still records the condition that reached it.
    // The loop above prepends, so the outermost branch is a8.
    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "positive:explicit:a8",
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      "negative:explicit:a8",
    ]);
    expect(pathSigs(result.byTerminal.get("LAST"))).toEqual([
      "<unconditional>",
    ]);
  });

  it("keeps both ways to a terminal when they do not cancel out", () => {
    // `if a: return` then `if b: return`, so the second return is reached
    // one way only and the tail keeps both guards.
    const first = ret();
    const second = ret();
    const tail = opq();
    const statements = [
      mkIf(cond("a"), [first], null),
      mkIf(cond("b"), [second], null),
      tail,
    ];
    const terminalsByStmt = new Map<S, string[]>([
      [first, ["T0"]],
      [second, ["T1"]],
      [tail, ["T2"]],
    ]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T1"))).toEqual([
      "negative:earlyReturn:a ∧ positive:explicit:b",
    ]);
    expect(pathSigs(result.byTerminal.get("T2"))).toEqual([
      "negative:earlyReturn:a ∧ negative:earlyReturn:b",
    ]);
  });

  it("degrades when branching alone crosses the cap, with no terminal in sight", () => {
    // A switch never needs a terminal to avoid collapsing (unlike an
    // if with neither an exit nor a terminal in either arm), so six
    // sequential three-way switches reach 3^6 = 729 paths without ever
    // calling recordTerminal. The budget check inside `enumerate`
    // itself is what catches this, not the one in recordTerminal.
    const threeWaySwitch = (): S =>
      mkSwitch([group("a", true, [opq()]), group("b", false, [opq()])]);
    const statements: S[] = Array.from({ length: 6 }, threeWaySwitch);

    expect(() =>
      enumerateStructuredPaths({ statements, terminalsByStmt: new Map() }),
    ).toThrow(PathBudgetExceeded);
  });
});

describe("enumerateStructuredPaths, opaque pass-through", () => {
  it("records a terminal that sits directly at the top level", () => {
    const marker = opq();
    const statements = [marker];
    const terminalsByStmt = new Map<S, string[]>([[marker, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
    expect(result.fallthrough.map(sig)).toEqual(["<unconditional>"]);
  });

  it("threads the condition's expression handle through unchanged", () => {
    const withExpr: ConditionHandle<string> = {
      sourceText: "a",
      expression: "expr-handle",
    };
    const t0 = ret();
    const statements = [mkIf(withExpr, [t0], null)];
    const terminalsByStmt = new Map<S, string[]>([[t0, ["T0"]]]);

    const result = enumerateStructuredPaths({ statements, terminalsByStmt });

    const [[info]] = result.byTerminal.get("T0") ?? [];
    expect(info?.expression).toBe("expr-handle");
  });
});

describe("enumerateOrDegrade", () => {
  it("gives every terminal one unreadable condition when the budget runs out", () => {
    const threeWaySwitch = (): S =>
      mkSwitch([group("a", true, [opq()]), group("b", false, [opq()])]);
    const statements: S[] = Array.from({ length: 6 }, threeWaySwitch);
    const terminalsByStmt = new Map<S, string[]>();

    const result = enumerateOrDegrade({ statements, terminalsByStmt }, [
      "T0",
      "T1",
    ]);

    expect(result.degraded).toBe("path budget exceeded, more than 256 paths");
    expect(pathSigs(result.byTerminal.get("T0"))).toEqual([
      "positive:explicit:unmodeled control flow (path budget exceeded, more than 256 paths)",
    ]);
    expect(pathSigs(result.byTerminal.get("T1"))).toHaveLength(1);
  });

  it("says what the lowering declined when it declined one", () => {
    const statements: S[] = [
      mkSwitch([
        group("a", false, [opq(), brk()]),
        group(null, false, [opq()]),
      ]),
    ];

    const result = enumerateOrDegrade(
      { statements, terminalsByStmt: new Map<S, string[]>() },
      ["T0"],
    );

    expect(result.degraded).toContain("break");
    expect(pathSigs(result.byTerminal.get("T0"))[0]).toContain(
      "unmodeled control flow",
    );
  });

  it("says nothing was degraded when the whole body was read", () => {
    const only = opq();
    const result = enumerateOrDegrade(
      { statements: [only], terminalsByStmt: new Map([[only, ["T0"]]]) },
      ["T0"],
    );

    expect(result.degraded).toBeNull();
    expect(pathSigs(result.byTerminal.get("T0"))).toEqual(["<unconditional>"]);
  });
});
