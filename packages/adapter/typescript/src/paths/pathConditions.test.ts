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

  it("non-exit non-terminal ifs collapse: no path split, legacy parity", () => {
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

  it("degrades when the path budget is exceeded", () => {
    // 9 sequential ifs whose arms both contain a (non-exit) terminal call
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

describe("computePathConditions, a block-wrapped case body ending in break", () => {
  it("degrades even when the block-wrapped clause is the only one (no default follows)", () => {
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
    const [only] = result.byTerminal.get(terminals[0]) ?? [];
    expect(only?.[only.length - 1]?.sourceText).toContain(
      "unmodeled control flow (non-trailing break in switch clause)",
    );
  });

  it("degrades the whole function, matching the legacy scanner exactly", () => {
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
    expect(terminals).toHaveLength(2);
    const result = computePathConditions(fn, terminals);
    for (const terminal of terminals) {
      const [only] = result.byTerminal.get(terminal) ?? [];
      expect(only?.[only.length - 1]?.sourceText).toContain(
        "unmodeled control flow (non-trailing break in switch clause)",
      );
    }
  });

  it("degrades when a sibling statement sits before the block", () => {
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
    expect(terminals).toHaveLength(3);
    const result = computePathConditions(fn, terminals);
    for (const terminal of terminals) {
      const [only] = result.byTerminal.get(terminal) ?? [];
      expect(only?.[only.length - 1]?.sourceText).toContain(
        "unmodeled control flow (non-trailing break in switch clause)",
      );
    }
  });

  it("degrades when the block is nested two deep", () => {
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
    expect(terminals).toHaveLength(3);
    const result = computePathConditions(fn, terminals);
    for (const terminal of terminals) {
      const [only] = result.byTerminal.get(terminal) ?? [];
      expect(only?.[only.length - 1]?.sourceText).toContain(
        "unmodeled control flow (non-trailing break in switch clause)",
      );
    }
  });

  it("degrades when the break sits inside an if inside a block", () => {
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

  it("degrades on a break three blocks deep in the middle of the clause", () => {
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

  it("degrades a block-wrapped continue inside a loop-wrapped switch, matching the legacy fallthrough reading", () => {
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
    expect(terminals).toHaveLength(2);
    const result = computePathConditions(fn, terminals);
    for (const terminal of terminals) {
      const [only] = result.byTerminal.get(terminal) ?? [];
      // A block hiding a continue is never recognized as ending the
      // clause's path (legacy's stepStatement dispatch never looks
      // inside a block either), so it reads the same as any other
      // non-empty clause with no trailing break: unsafe to fall
      // through into whatever clause follows.
      expect(only?.[only.length - 1]?.sourceText).toContain(
        "unmodeled control flow (fallthrough into a non-empty switch clause)",
      );
    }
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
    // The default's return is gated on kind !== "a"; the empty block
    // ahead of the trailing break contributes nothing, so "a" reads
    // exactly as a bare `case "a": break;` would.
    expect(pathSigs(result?.byTerminal.get(terminals[0]))).toEqual([
      'negative:explicit:req.query.kind === "a"',
    ]);
  });

  it("keeps legacy's single flat transition for a block-wrapped nested switch with no stray break and no direct terminal", () => {
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
    const paths = pathSigs(result?.byTerminal.get(terminals[0]));
    // Legacy never looked inside a block for control-flow structure,
    // only for a break its descendant scan could find. The nested
    // switch inside the block owns its own break (switches are
    // skipped by that scan), so the clause comes out as one flat
    // "kind === b" match, with no trace of the inner switch's own
    // "x" / default distinction. The whole block is one pass-through,
    // and since nothing inside it returns or throws, the negation
    // comes out as an ordinary explicit non-match, not an early return.
    expect(paths).toEqual([
      'negative:explicit:req.query.kind === "b"',
      'positive:explicit:req.query.kind === "b"',
    ]);
    for (const path of paths) {
      expect(path).not.toContain('=== "x"');
    }
  });
});
