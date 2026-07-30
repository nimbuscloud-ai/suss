// pathConditions.test.ts — direct coverage of the CFG path engine.
//
// The shadow evidence for the cutover: legacy-sound shapes must yield
// byte-identical condition lists to the legacy collectors; the shapes
// the legacy collectors got wrong (nested guards, sibling guards in a
// block, else-exits, loop exits) must yield the sound per-path lists;
// unmodeled constructs must bail to legacy (null).

import { Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  collectAncestorConditionInfos,
  collectEarlyReturnConditionInfos,
} from "../conditions.js";
import { computePathConditions } from "./pathConditions.js";

import type { ConditionInfo, FunctionRoot } from "../conditions.js";

function getFunction(source: string): FunctionRoot {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("test.ts", source);
  const fn = file.getFunctions().find((f) => f.isExported());
  if (fn === undefined) {
    throw new Error("No exported function found");
  }
  return fn;
}

/** All `return` statements in the unit — the test-double for terminals. */
function returnTerminals(fn: FunctionRoot): Node[] {
  return fn.getDescendantsOfKind(SyntaxKind.ReturnStatement);
}

const sig = (infos: ConditionInfo[]): string =>
  infos.map((c) => `${c.polarity}:${c.source}:${c.sourceText}`).join(" ∧ ") ||
  "<unconditional>";

const pathSigs = (paths: ConditionInfo[][] | undefined): string[] =>
  (paths ?? []).map(sig).sort();

describe("computePathConditions — parity with legacy on sound shapes", () => {
  it("guard chain: identical conditions to the legacy collectors", () => {
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
    expect(result).not.toBeNull();

    for (const terminal of terminals) {
      const legacy = [
        ...collectEarlyReturnConditionInfos(terminal, fn),
        ...collectAncestorConditionInfos(terminal, fn),
      ];
      expect(pathSigs(result?.byTerminal.get(terminal))).toEqual([sig(legacy)]);
    }
  });

  it("final if/else after guards: identical conditions to legacy", () => {
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
    for (const terminal of terminals) {
      const legacy = [
        ...collectEarlyReturnConditionInfos(terminal, fn),
        ...collectAncestorConditionInfos(terminal, fn),
      ];
      expect(pathSigs(result?.byTerminal.get(terminal))).toEqual([sig(legacy)]);
    }
  });

  it("non-exit non-terminal ifs collapse — no path split, legacy parity", () => {
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

describe("computePathConditions — shapes the legacy collectors got wrong", () => {
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
    // The fallthrough 200: [¬a] and [a, ¬b] — never ¬a ∧ ¬b.
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

describe("computePathConditions — conservative bails", () => {
  const bailSources = [
    [
      "try",
      "try { return { status: 200 }; } catch { return { status: 500 }; }",
    ],
    ["break", "for (const k of a) { break; }\nreturn { status: 200 };"],
    ["continue", "for (const k of a) { continue; }\nreturn { status: 200 };"],
    ["labeled", "outer: for (const k of a) { }\nreturn { status: 200 };"],
  ] as const;

  for (const [name, body] of bailSources) {
    it(`bails to legacy on ${name}`, () => {
      const fn = getFunction(`
        export function handler(a: any) {
          ${body}
        }
      `);
      expect(computePathConditions(fn, returnTerminals(fn))).toBeNull();
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
    // The if-arm's forEach return is the callback's, not the unit's —
    // the if collapses and the final return stays unconditional.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      "<unconditional>",
    ]);
  });

  it("bails when the path budget is exceeded", () => {
    // 9 sequential ifs whose arms both hold a (non-exit) terminal call
    // double the frontier each: 2^9 = 512 > 256.
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
    expect(computePathConditions(fn, termCalls)).toBeNull();
  });
});

describe("computePathConditions — switch lowering", () => {
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

  it("declines fallthrough into a non-empty clause", () => {
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
    expect(computePathConditions(fn, returnTerminals(fn))).toBeNull();
  });

  it("declines a non-trailing break", () => {
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
    expect(computePathConditions(fn, returnTerminals(fn))).toBeNull();
  });

  it("still declines breaks that bind to loops", () => {
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
    expect(computePathConditions(fn, returnTerminals(fn))).toBeNull();
  });
});
