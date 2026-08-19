// pathConditions.test.ts: direct coverage of the CFG path engine.
//
// Pins the engine's semantics directly: sound shapes keep the exact
// condition lists the legacy collectors produced before their
// deletion (transition-ID stability), the shapes those collectors got
// wrong (nested guards, sibling guards in a block, else-exits, loop
// exits) yield the sound per-path lists, and declined shapes degrade
// to enclosure conditions plus an opaque unmodeled-flow conjunct.

import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { computePathConditions } from "./pathConditions.js";

import type { ConditionInfo, FunctionRoot } from "../conditions.js";

function getFunction(source: string): FunctionRoot {
  const project = createTestProject();
  const file = project.createSourceFile("test.ts", source);
  const fn = file.getFunctions().find((f) => f.isExported());
  if (fn === undefined) {
    throw new Error("No exported function found");
  }
  return fn;
}

/** All `return` statements in the unit: the test-double for terminals. */
function returnTerminals(fn: FunctionRoot): Node[] {
  return fn.getDescendantsOfKind(SyntaxKind.ReturnStatement);
}

const sig = (infos: ConditionInfo[]): string =>
  infos.map((c) => `${c.polarity}:${c.source}:${c.sourceText}`).join(" ∧ ") ||
  "<unconditional>";

const pathSigs = (paths: ConditionInfo[][] | undefined): string[] =>
  (paths ?? []).map(sig).sort();

describe("computePathConditions: stable conditions on sound shapes", () => {
  it("guard chain: guards accumulate as negated early returns", () => {
    const fn = getFunction(`
      export function handler(a: any, b: any) {
        if (!a) {
          return { status: 400 };
        }
        if (!b) {
          return { status: 401 };
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "positive:explicit:!a",
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      "negative:earlyReturn:!a ∧ positive:explicit:!b",
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      "negative:earlyReturn:!a ∧ negative:earlyReturn:!b",
    ]);
  });

  it("final if/else after guards: both arms carry the passed guard", () => {
    const fn = getFunction(`
      export function handler(a: any, b: any) {
        if (!a) {
          return { status: 400 };
        }
        if (b === "x") {
          return { status: 200 };
        } else {
          return { status: 404 };
        }
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'negative:earlyReturn:!a ∧ positive:explicit:b === "x"',
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      'negative:earlyReturn:!a ∧ negative:explicit:b === "x"',
    ]);
  });

  it("a branch that rejoins before the terminal leaves nothing on it", () => {
    const fn = getFunction(`
      export function handler(a: any, log: any) {
        if (a) {
          log("hello");
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("the same branch with nothing after it leaves both arms on the fall-through", () => {
    const fn = getFunction(`
      export function handler(a: any, log: any) {
        if (a) {
          log("hello");
        } else {
          log("goodbye");
        }
      }
    `);
    const result = computePathConditions(fn, []);
    expect((result?.fallthrough ?? []).map(sig).sort()).toEqual([
      "<unconditional>",
      "negative:explicit:a",
      "positive:explicit:a",
    ]);
  });

  it("expression-level branching (ternary) composes after path conditions", () => {
    const fn = getFunction(`
      export function handler(a: any, b: any) {
        if (!a) {
          return { status: 400 };
        }
        return b ? { status: 200 } : { status: 404 };
      }
    `);
    // Terminals: the two object literals inside the ternary arms.
    const literals = fn
      .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
      .filter((node) => {
        const parent = node.getParent();
        return parent !== undefined && Node.isConditionalExpression(parent);
      });
    expect(literals).toHaveLength(2);
    const result = computePathConditions(fn, literals);
    expect(pathSigs(result?.byTerminal.get(literals[0]))).toEqual([
      "negative:earlyReturn:!a ∧ positive:explicit:b",
    ]);
    expect(pathSigs(result?.byTerminal.get(literals[1]))).toEqual([
      "negative:earlyReturn:!a ∧ negative:explicit:b",
    ]);
  });
});

describe("computePathConditions: shapes the legacy collectors got wrong", () => {
  it("nested guard: the fallthrough gets one branch per real path", () => {
    const fn = getFunction(`
      export function handler(a: any, b: any) {
        if (a) {
          if (b) {
            return { status: 400 };
          }
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);

    // The nested 400: both conditions positive, ancestor-classified.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "positive:explicit:a ∧ positive:explicit:b",
    ]);
    // The fallthrough 200: [¬a] and [a, ¬b]: never ¬a ∧ ¬b.
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      "negative:earlyReturn:a",
      "positive:explicit:a ∧ negative:earlyReturn:b",
    ]);
  });

  it("sibling guard in a block: the tail carries the guard's negation", () => {
    const fn = getFunction(`
      export function handler(a: any, b: any) {
        if (a) {
          if (b) {
            return { status: 401 };
          }
          return { status: 200 };
        }
        return { status: 404 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    // The tail 200: a (ancestor) ∧ ¬b (sibling guard passed).
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      "positive:explicit:a ∧ negative:earlyReturn:b",
    ]);
    // The final 404: just ¬a.
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      "negative:earlyReturn:a",
    ]);
  });

  it("else-exit: statements after the if are gated on the then-branch", () => {
    const fn = getFunction(`
      export function handler(a: any, log: any) {
        if (a) {
          log("ok");
        } else {
          return { status: 500 };
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    // Legacy recorded nothing for the final 200 (the guard's exit lives
    // in the else-arm, invisible to both legacy collectors).
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      "positive:explicit:a",
    ]);
  });

  it("loop exits: in-loop terminals and the fallthrough both opacify", () => {
    const fn = getFunction(`
      export function handler(keys: any, q: any) {
        for (const key of keys) {
          if (!q[key]) {
            return { status: 400 };
          }
        }
        return { status: 201 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);

    const inLoop = pathSigs(result?.byTerminal.get(terminals[0]));
    expect(inLoop).toHaveLength(1);
    expect(inLoop[0]).toContain("some iteration of:");
    expect(inLoop[0]).toContain("positive:explicit:!q[key]");

    const afterLoop = pathSigs(result?.byTerminal.get(terminals[1]));
    expect(afterLoop).toHaveLength(1);
    expect(afterLoop[0]).toContain(
      "negative:earlyReturn:loop exited via return:",
    );
  });

  it("loops without exits add no conditions to the fallthrough", () => {
    const fn = getFunction(`
      export function handler(keys: any, log: any) {
        for (const key of keys) {
          log(key);
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("dead code after an unconditional return yields no paths", () => {
    const fn = getFunction(`
      export function handler() {
        return { status: 200 };
        return { status: 500 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
    expect(result?.byTerminal.has(terminals[1])).toBe(false);
  });

  it("fallthrough paths carry the guards they passed", () => {
    const fn = getFunction(`
      export function handler(a: any, log: any) {
        if (!a) {
          return { status: 400 };
        }
        log("no explicit return");
      }
    `);
    const result = computePathConditions(fn, returnTerminals(fn));
    expect((result?.fallthrough ?? []).map(sig)).toEqual([
      "negative:earlyReturn:!a",
    ]);
  });
});

describe("computePathConditions: sound degradation on declined shapes", () => {
  const declinedSources = [
    ["labeled", "outer: for (const k of a) { }\nreturn { status: 200 };"],
    [
      "finally with a return",
      "try { f(); } finally { return { status: 200 }; }",
    ],
  ] as const;

  for (const [name, body] of declinedSources) {
    it(`degrades to an opaque unmodeled-flow conjunct on ${name}`, () => {
      const fn = getFunction(`
        export function handler(a: any, f: () => void) {
          ${body}
        }
      `);
      const terminals = returnTerminals(fn);
      const result = computePathConditions(fn, terminals);
      const paths = result.byTerminal.get(terminals[0]) ?? [];
      expect(paths).toHaveLength(1);
      const marker = paths[0][paths[0].length - 1];
      expect(marker.sourceText).toContain("unmodeled control flow");
      expect(marker.expression).toBeNull();
    });
  }

  it("does NOT bail on unmodeled flow inside nested callbacks", () => {
    const fn = getFunction(`
      export function handler(items: any) {
        items.forEach((item: any) => {
          switch (item) {
            case 1:
              break;
          }
        });
        return { status: 200 };
      }
    `);
    expect(computePathConditions(fn, returnTerminals(fn))).not.toBeNull();
  });

  it("ignores return statements inside nested functions for exit analysis", () => {
    const fn = getFunction(`
      export function handler(a: any, items: any) {
        if (a) {
          items.forEach(() => {
            return;
          });
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn).filter(
      (r) =>
        r.getFirstDescendantByKind(SyntaxKind.ObjectLiteralExpression) !==
        undefined,
    );
    const result = computePathConditions(fn, terminals);
    // The if-arm's forEach return is the callback's, not the unit's ,
    // the if collapses and the final return stays unconditional.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("keeps a run of rejoining guards at one path instead of degrading", () => {
    // Nine sequential ifs whose arms both call `term` and neither exits.
    // Each call keeps the guard that reached it, and the return after all
    // nine did not depend on any of them.
    const branchy = Array.from(
      { length: 9 },
      (_, i) => `if (a${i}) { term(); } else { term(); }`,
    ).join("\n");
    const fn = getFunction(`
      export function handler(term: any, ${Array.from({ length: 9 }, (_, i) => `a${i}: any`).join(", ")}) {
        ${branchy}
        return { status: 200 };
      }
    `);
    const termCalls = fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getExpression().getText() === "term");
    expect(termCalls.length).toBe(18);

    const result = computePathConditions(fn, termCalls);

    const [first] = result.byTerminal.get(termCalls[0]) ?? [];
    expect(first?.map((c) => `${c.polarity}:${c.sourceText}`)).toEqual([
      "positive:a0",
    ]);
    const [second] = result.byTerminal.get(termCalls[1]) ?? [];
    expect(second?.map((c) => `${c.polarity}:${c.sourceText}`)).toEqual([
      "negative:a0",
    ]);
    // One way to each call, rather than one for every combination of the
    // other eight guards.
    const entries = [...result.byTerminal.values()].map((p) => p.length);
    expect(entries).toEqual(Array.from({ length: 18 }, () => 1));
  });

  it("degrades when the path budget is exceeded", () => {
    // Six sequential three-way switches reach 3^6 = 729 paths. A switch
    // group has no complement to cancel against, so nothing merges.
    const switches = Array.from(
      { length: 6 },
      (_, i) =>
        `switch (k${i}) { case "a": term(); break; case "b": term(); break; default: term(); }`,
    ).join("\n");
    const fn = getFunction(`
      export function handler(term: any, ${Array.from({ length: 6 }, (_, i) => `k${i}: any`).join(", ")}) {
        ${switches}
        return { status: 200 };
      }
    `);
    const termCalls = fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getExpression().getText() === "term");
    const result = computePathConditions(fn, termCalls);
    const [only] = result.byTerminal.get(termCalls[0]) ?? [];
    expect(only?.[only.length - 1]?.sourceText).toContain(
      "path budget exceeded",
    );
  });
});

describe("computePathConditions: switch lowering", () => {
  it("case groups carry the legacy-identical synthetic condition", () => {
    const fn = getFunction(`
      export function handler(kind: string) {
        switch (kind) {
          case "a":
            return { status: 200 };
          case "b":
          case "c":
            return { status: 404 };
        }
        return { status: 500 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(result).not.toBeNull();
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'positive:explicit:kind === "a"',
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'positive:explicit:kind === "b" || kind === "c"',
    ]);
    // After the switch: negations of every bodied group.
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      'negative:earlyReturn:kind === "a" ∧ negative:earlyReturn:kind === "b" || kind === "c"',
    ]);
  });

  it("trailing-break bodies join after the switch", () => {
    const fn = getFunction(`
      export function handler(kind: string, log: (m: string) => void) {
        switch (kind) {
          case "a":
            log("a");
            break;
          default:
            return { status: 400 };
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    // The 400 in default requires matching no case.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'negative:explicit:kind === "a"',
    ]);
    // The 200 after the switch is reached only via the break path.
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'positive:explicit:kind === "a"',
    ]);
  });

  it("sees the branches inside a braced case", () => {
    const fn = getFunction(`
      export function handler(kind: string, flag: boolean) {
        switch (kind) {
          case "b": {
            if (flag) {
              return { status: 404 };
            }
            break;
          }
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    // The braces only scope the case; the if inside branches the paths.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'positive:explicit:kind === "b" ∧ positive:explicit:flag',
    ]);
  });

  it("keeps a trailing break written inside the case's braces", () => {
    const fn = getFunction(`
      export function handler(kind: string, log: (m: string) => void) {
        switch (kind) {
          case "a": {
            const label = "a";
            log(label);
            break;
          }
          default:
            return { status: 400 };
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'positive:explicit:kind === "a"',
    ]);
  });

  it("sees the conditions of a switch nested in a braced case", () => {
    const fn = getFunction(`
      export function handler(kind: string, log: (m: string) => void) {
        switch (kind) {
          case "b": {
            switch (kind) {
              case "x":
                return { status: 404 };
              default:
                log("other");
            }
          }
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    const sigs = pathSigs(result?.byTerminal.get(terminals[0]));
    expect(sigs?.[0]).toContain('kind === "b"');
    expect(sigs?.[0]).toContain('kind === "x"');
  });

  it("degrades on fallthrough into a non-empty clause", () => {
    const fn = getFunction(`
      export function handler(kind: string, log: (m: string) => void) {
        switch (kind) {
          case "a":
            log("a");
          case "b":
            return { status: 200 };
        }
        return { status: 500 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    const [only] = result.byTerminal.get(terminals[1]) ?? [];
    expect(only?.[only.length - 1]?.sourceText).toContain(
      "unmodeled control flow",
    );
  });

  it("degrades on a non-trailing break", () => {
    const fn = getFunction(`
      export function handler(kind: string, x: boolean) {
        switch (kind) {
          case "a":
            if (x) {
              break;
            }
            return { status: 200 };
        }
        return { status: 500 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    const [only] = result.byTerminal.get(terminals[1]) ?? [];
    expect(only?.[only.length - 1]?.sourceText).toContain(
      "unmodeled control flow",
    );
  });

  it("models loop breaks as path enders: the after-loop terminal stays clean", () => {
    const fn = getFunction(`
      export function handler(items: string[]) {
        for (const item of items) {
          if (item === "stop") {
            break;
          }
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("models loop continues as path enders too", () => {
    const fn = getFunction(`
      export function handler(items: string[]) {
        for (const item of items) {
          if (item === "skip") {
            continue;
          }
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("degrades on a default clause that isn't last", () => {
    const fn = getFunction(`
      export function handler(kind: string) {
        switch (kind) {
          default:
            return { status: 400 };
          case "a":
            return { status: 200 };
        }
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    const [only] = result.byTerminal.get(terminals[0]) ?? [];
    expect(only?.[only.length - 1]?.sourceText).toContain(
      "unmodeled control flow",
    );
  });

  it("an empty default clause behaves like no default at all", () => {
    const fn = getFunction(`
      export function handler(kind: string) {
        switch (kind) {
          case "a":
            return { status: 200 };
          default:
        }
        return { status: 500 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'negative:earlyReturn:kind === "a"',
    ]);
  });
});

describe("computePathConditions, a terminal outside the given function", () => {
  it("degrades when a caller-given terminal isn't reachable from this body", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "test.ts",
      `
        export function handler(a: boolean) {
          if (a) {
            return { status: 200 };
          }
          return { status: 400 };
        }
        export function other() {
          return { status: 500 };
        }
      `,
    );
    const [handler, other] = file.getFunctions();
    const foreignTerminal = other
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .at(0);
    if (handler === undefined || foreignTerminal === undefined) {
      throw new Error("fixture functions not found");
    }
    const result = computePathConditions(handler, [foreignTerminal]);
    const [only] = result.byTerminal.get(foreignTerminal) ?? [];
    expect(only?.[only.length - 1]?.sourceText).toContain(
      "unmodeled control flow",
    );
  });
});

describe("computePathConditions: try/catch", () => {
  it("catch terminals carry the legacy catch condition; rethrows too", () => {
    const fn = getFunction(`
      export function handler(load: () => { status: number }) {
        try {
          return { status: 200 };
        } catch (err) {
          throw err;
        }
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
    const throws = fn.getDescendantsOfKind(SyntaxKind.ThrowStatement);
    const throwResult = computePathConditions(fn, throws);
    expect(pathSigs(throwResult?.byTerminal.get(throws[0]))).toEqual([
      "positive:catchBlock:catch",
    ]);
  });

  it("a catch that falls through splits the after-try terminal per route", () => {
    const fn = getFunction(`
      export function handler(log: (m: string) => void) {
        try {
          log("attempt");
        } catch (err) {
          log("recovered");
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
      "positive:catchBlock:catch",
    ]);
  });

  it("guards inside a catch compose with the catch condition", () => {
    const fn = getFunction(`
      export function handler(load: () => void, isFatal: (e: unknown) => boolean) {
        try {
          load();
        } catch (err) {
          if (isFatal(err)) {
            return { status: 500 };
          }
          return { status: 502 };
        }
        return { status: 200 };
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "positive:catchBlock:catch ∧ positive:explicit:isFatal(err)",
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      "positive:catchBlock:catch ∧ negative:earlyReturn:isFatal(err)",
    ]);
    // After-try only via the non-throwing route (the catch always exits).
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("allows a pure-cleanup finally as a pass-through", () => {
    const fn = getFunction(`
      export function handler(conn: { release: () => void }) {
        try {
          return { status: 200 };
        } finally {
          conn.release();
        }
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });
});

describe("computePathConditions, no body to read", () => {
  it("an ambient declaration has nothing to enumerate", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "test.ts",
      "export declare function handler(a: boolean): void;",
    );
    const fn = file.getFunctions().find((f) => f.isExported());
    if (fn === undefined) {
      throw new Error("fixture function not found");
    }
    const result = computePathConditions(fn, []);
    expect(result.byTerminal.size).toBe(0);
    expect(result.fallthrough).toEqual([]);
  });

  it("a degraded result skips the synthetic fallthrough terminal, same as a sound one", () => {
    const fn = getFunction(`
      export function handler(a: boolean) {
        outer: for (const x of [a]) {
          if (x) {
            break outer;
          }
        }
        return { status: 200 };
      }
    `);
    const body = fn.getBody();
    if (body === undefined) {
      throw new Error("fixture body not found");
    }
    // Mirrors makeFallthroughTerminal: the body itself stands in for
    // the implicit fall-through return, and never gets its own entry.
    const result = computePathConditions(fn, [body]);
    expect(result.byTerminal.has(body)).toBe(false);
    expect(result.fallthrough[0]?.[0]?.sourceText).toContain(
      "unmodeled control flow",
    );
  });
});

describe("computePathConditions, a braced case body splices into the clause", () => {
  it("models the only clause when its braces end in a break", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "a": {
            const tag = computeTag();
            break;
          }
        }
        return res.status(200).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    // The return is reached matched-and-broken or unmatched.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'negative:explicit:req.query.kind === "a"',
      'positive:explicit:req.query.kind === "a"',
    ]);
  });

  it("models a braced break beside a returning default", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "a": {
            const tag = computeTag();
            break;
          }
          default:
            return res.status(400).json({ error: "bad" });
        }
        return res.status(200).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'negative:explicit:req.query.kind === "a"',
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'positive:explicit:req.query.kind === "a"',
    ]);
  });

  it("models a sibling statement ahead of the braces", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "a":
            return res.status(200).json({ ok: true });
          case "b":
            console.log("entering b");
            {
              const tag = "b-like";
              console.log(tag);
              break;
            }
          default:
            return res.status(400).json({ error: "bad" });
        }
        return res.status(204).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'positive:explicit:req.query.kind === "a"',
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[1]))).toEqual([
      'negative:earlyReturn:req.query.kind === "a" ∧ negative:explicit:req.query.kind === "b"',
    ]);
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      'positive:explicit:req.query.kind === "b"',
    ]);
  });

  it("models a block nested two deep the same way", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "a":
            return res.status(200).json({ ok: true });
          case "b": {
            {
              const tag = "b-like";
              console.log(tag);
              break;
            }
          }
          default:
            return res.status(400).json({ error: "bad" });
        }
        return res.status(204).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[2]))).toEqual([
      'positive:explicit:req.query.kind === "b"',
    ]);
  });

  it("still degrades on a break behind an if inside the braces", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string }; x: boolean }, res: any) {
        switch (req.query.kind) {
          case "a":
            return res.status(200).json({ ok: true });
          case "b": {
            if (req.x) {
              break;
            }
          }
          default:
            return res.status(400).json({ error: "bad" });
        }
        return res.status(204).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    expect(terminals).toHaveLength(3);
    const result = computePathConditions(fn, terminals);
    for (const terminal of terminals) {
      const [only] = result.byTerminal.get(terminal) ?? [];
      expect(only?.[only.length - 1]?.sourceText).toContain(
        "unmodeled control flow (non-trailing break in switch clause)",
      );
    }
  });

  it("still degrades on a mid-clause break, however many blocks wrap it", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "a":
            return res.status(200).json({ ok: true });
          case "b":
            console.log("before");
            {
              {
                {
                  break;
                }
              }
            }
            console.log("after");
            break;
          default:
            return res.status(400).json({ error: "bad" });
        }
        return res.status(204).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    expect(terminals).toHaveLength(3);
    const result = computePathConditions(fn, terminals);
    for (const terminal of terminals) {
      const [only] = result.byTerminal.get(terminal) ?? [];
      expect(only?.[only.length - 1]?.sourceText).toContain(
        "unmodeled control flow (non-trailing break in switch clause)",
      );
    }
  });

  it("lets a braced continue end its clause inside a loop", () => {
    const fn = getFunction(`
      export function handler(items: string[], res: any) {
        for (const item of items) {
          switch (item) {
            case "skip": {
              continue;
            }
            default:
              return res.status(400).json({ error: "bad" });
          }
        }
        return res.status(200).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    // The 400 needs a non-skip item; all-skip iterations reach the 200.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'positive:explicit:some iteration of: for (const item of items) ∧ negative:explicit:item === "skip"',
    ]);
  });

  it("does not degrade on an empty block ahead of a genuine trailing break", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "a": {
          }
            break;
          default:
            return res.status(400).json({ error: "bad" });
        }
        return res.status(200).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'negative:explicit:req.query.kind === "a"',
    ]);
  });

  it("models the branches of a switch nested in a braced case", () => {
    const fn = getFunction(`
      export function handler(req: { query: { kind: string } }, res: any) {
        switch (req.query.kind) {
          case "b": {
            switch (req.query.kind) {
              case "x":
                console.log("x");
                break;
              default:
                console.log("other");
            }
          }
        }
        return res.status(200).json({ ok: true });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'negative:explicit:req.query.kind === "b"',
      'positive:explicit:req.query.kind === "b" ∧ negative:explicit:req.query.kind === "x"',
      'positive:explicit:req.query.kind === "b" ∧ positive:explicit:req.query.kind === "x"',
    ]);
  });
});

describe("computePathConditions, branches written inside a callback", () => {
  it("a guard in a then callback branches the paths the statement leaves on", () => {
    const fn = getFunction(`
      export function load(id: string) {
        fetch("/thing/" + id).then((res) => {
          if (!res.ok) {
            reportFailure(res.status);
          } else {
            reportSuccess(res);
          }
        });
      }
    `);
    const result = computePathConditions(fn, []);
    expect((result?.fallthrough ?? []).map(sig).sort()).toEqual([
      "<unconditional>",
      "negative:explicit:!res.ok",
      "positive:explicit:!res.ok",
    ]);
  });

  it("a guard in a map callback does the same", () => {
    const fn = getFunction(`
      export function loadAll(ids: string[]) {
        ids.map((id) => {
          if (id.length === 0) {
            skip(id);
          } else {
            keep(id);
          }
        });
      }
    `);
    const result = computePathConditions(fn, []);
    expect((result?.fallthrough ?? []).map(sig).sort()).toEqual([
      "<unconditional>",
      "negative:explicit:id.length === 0",
      "positive:explicit:id.length === 0",
    ]);
  });

  it("a guard in a promise executor does the same", () => {
    const fn = getFunction(`
      export function loadOnce(id: string) {
        return new Promise((resolve, reject) => {
          if (id === "") {
            reject(new Error("no id"));
          } else {
            resolve(id);
          }
        });
      }
    `);
    const terminals = returnTerminals(fn);
    const result = computePathConditions(fn, terminals);
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
      'negative:explicit:id === ""',
      'positive:explicit:id === ""',
    ]);
  });

  it("the unit's own return is reported once per path the callback takes", () => {
    const fn = getFunction(`
      export function load(id: string) {
        return fetch("/thing/" + id).then((res) => {
          if (!res.ok) {
            return null;
          }
          return res.json();
        });
      }
    `);
    const outer = fn
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((r) => r.getParent()?.getParent() === fn);
    const result = computePathConditions(fn, outer);
    // Both the callback's own returns and the unit's exit stay one
    // terminal: the guard splits how it is reached, not what it is.
    expect(result?.byTerminal.size).toBe(1);
    expect(pathSigs(result?.byTerminal.get(outer[0]))).toEqual([
      "<unconditional>",
      "negative:earlyReturn:!res.ok",
      "positive:explicit:!res.ok",
    ]);
  });

  it("a return inside a callback leaves the callback, so what follows the call still runs", () => {
    const fn = getFunction(`
      export function load(id: string) {
        fetch("/thing/" + id).then((res) => {
          if (!res.ok) {
            return;
          }
          use(res);
        });
        markStarted();
      }
    `);
    const result = computePathConditions(fn, []);
    // One path, not the guarded half: had the callback's return ended
    // the unit's path, `markStarted()` would only be reached when the
    // guard did not fire, and the fall-through would say so.
    expect((result?.fallthrough ?? []).map(sig)).toEqual(["<unconditional>"]);
  });

  it("an arrow written without braces still branches on the callbacks in it", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "expr.ts",
      `
        export const submit = async (id: string) =>
          await fetch("/thing/" + id).then((res) => {
            if (res.error) {
              reportFailure(res.error);
            } else {
              reportSuccess();
            }
          });
      `,
    );
    const arrow = file.getDescendantsOfKind(SyntaxKind.ArrowFunction)[0];
    if (arrow === undefined) {
      throw new Error("no arrow to read");
    }
    const body = arrow.getBody();
    const result = computePathConditions(arrow, [body]);
    expect(pathSigs(result?.byTerminal.get(body))).toEqual([
      "<unconditional>",
      "negative:explicit:res.error",
      "positive:explicit:res.error",
    ]);
  });

  it("a callback a pack claimed as a sub-unit contributes nothing to the parent", () => {
    const fn = getFunction(`
      export function register(app: any) {
        app.get("/thing", (req, res) => {
          if (req.query.id === undefined) {
            res.status(400);
          } else {
            res.status(200);
          }
        });
      }
    `);
    const handler = fn.getDescendantsOfKind(SyntaxKind.ArrowFunction)[0];
    if (handler === undefined) {
      throw new Error("no handler to claim");
    }
    const result = computePathConditions(fn, [], new Set<Node>([handler]));
    expect((result?.fallthrough ?? []).map(sig)).toEqual(["<unconditional>"]);
  });
});
