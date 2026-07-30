// corpus.test.ts — the permanent counterexample corpus.
//
// Every entry is a shrunk counterexample from a real fuzz run, pinned
// as a concrete (program, request, verdict) triple:
//
// - `gap:*` entries document a KNOWN soundness gap: the test asserts
//   the mismatch still reproduces. When WS-2's rework closes the gap,
//   the entry fails — that's the signal to flip its verdict to
//   "clean", turning the same triple into a regression fixture.
// - `fixed:*` entries pin a bug that has been fixed: the test asserts
//   the run is clean. They are the regression suite the fuzzer earns
//   over time.
//
// Corpus log:
// - 2026-07-30: nested-guard shapes (2 entries) and loop-return shape
//   (1 entry) captured from the first fuzz session (seeds 8317838,
//   1436983, and the loop tier's first round).
// - 2026-07-30: dynamic element-access index — the fuzzer's first NEW
//   find (not previously documented): `obj[key]` with a variable index
//   was encoded as `indexAccess("key")`, indistinguishable from
//   `obj["key"]`, so a dynamic read masqueraded as a static property
//   read and produced false claims. Fixed in
//   packages/adapter/typescript/src/subjects.ts (dynamic index →
//   unresolved). Entry pins the fixed behavior.

import { describe, expect, it } from "vitest";

import { judgeObservation, renderProgram } from "./differential.js";
import { executeHandler } from "./execute.js";
import { extractHandlerSummary } from "./extract.js";
import { EXPRESS_TARGET } from "./target.js";

import type { HandlerProgram } from "./program.js";
import type { GeneratedRequest } from "./requests.js";

type ExpectedVerdict = "falseClaim" | "uncovered" | "clean";

interface CorpusEntry {
  name: string;
  tag: string;
  program: HandlerProgram;
  expectations: {
    request: Partial<GeneratedRequest>;
    verdict: ExpectedVerdict;
  }[];
}

const req = (partial: Partial<GeneratedRequest>): GeneratedRequest => ({
  params: {},
  query: {},
  headers: {},
  body: {},
  ...partial,
});

const truthyQ = {
  type: "truthy",
  field: { source: "query", key: "q" },
  negated: false,
} as const;

const truthyAuth = {
  type: "truthy",
  field: { source: "headers", key: "authorization" },
  negated: false,
} as const;

const CORPUS: CorpusEntry[] = [
  {
    name: "nested guard: outer if wrapping a guard is invisible to later terminals",
    tag: "gap:nested-guard",
    // if (q) { if (q) { 400; return; } }  res.json(200)
    // The outer if's then-block has no *direct* return, so the guard
    // walker never records it — the final 200 claims to be
    // unconditional while execution 400s.
    program: {
      guards: [
        {
          type: "nestedGuard",
          outer: truthyQ,
          inner: truthyQ,
          terminal: { status: 400, key: "error", value: "no" },
        },
      ],
      final: {
        type: "respond",
        terminal: { status: null, key: "ok", value: "yes" },
      },
    },
    expectations: [
      { request: { query: { q: "a" } }, verdict: "falseClaim" },
      { request: {}, verdict: "clean" },
    ],
  },
  {
    name: "block guard: tail terminal misses its sibling guard's negation",
    tag: "gap:nested-guard",
    // if (q) { if (auth) { 401; return; } 200; return; }  404
    program: {
      guards: [
        {
          type: "blockGuard",
          outer: truthyQ,
          inner: truthyAuth,
          whenInner: { status: 401, key: "error", value: "no" },
          tail: { status: null, key: "ok", value: "yes" },
        },
      ],
      final: {
        type: "respond",
        terminal: { status: 404, key: "error", value: "x" },
      },
    },
    expectations: [
      // Tail claims [q] but truth is q ∧ ¬auth: 401 observed, tail true.
      {
        request: { query: { q: "a" }, headers: { authorization: "a" } },
        verdict: "falseClaim",
      },
      // Final claims ¬q ∧ ¬auth but truth is just ¬q: 404 observed,
      // no transition admits it.
      { request: { headers: { authorization: "a" } }, verdict: "uncovered" },
      { request: { query: { q: "a" } }, verdict: "clean" },
    ],
  },
  {
    name: "loop guard: terminal after the loop misses the loop-guard negation",
    tag: "gap:loop-return",
    // for (const key of ["q"]) { if (!req.query[key]) { 400; return; } }  201
    program: {
      guards: [
        {
          type: "loopGuard",
          source: "query",
          keys: ["q"],
          terminal: { status: 400, key: "error", value: "no" },
        },
      ],
      final: {
        type: "respond",
        terminal: { status: 201, key: "ok", value: "yes" },
      },
    },
    expectations: [
      // Loop guard fires (q missing) → 400 observed, but the 201
      // transition still claims unconditional truth.
      { request: {}, verdict: "falseClaim" },
    ],
  },
  {
    name: "dynamic element-access index abstains instead of fabricating a static read",
    tag: "fixed:dynamic-index",
    // Same loop program, but the request *passes* the guard. Before
    // the subjects.ts fix, `!req.query[key]` was encoded as
    // indexAccess("key") — a static read of the literal property
    // "key" — so the 400 transition evaluated TRUE on this request
    // and produced a false claim. Post-fix the dynamic access is
    // unresolved and the transition abstains.
    program: {
      guards: [
        {
          type: "loopGuard",
          source: "query",
          keys: ["q"],
          terminal: { status: 400, key: "error", value: "no" },
        },
      ],
      final: {
        type: "respond",
        terminal: { status: 201, key: "ok", value: "yes" },
      },
    },
    expectations: [{ request: { query: { q: "a" } }, verdict: "clean" }],
  },
];

describe("differential corpus", () => {
  for (const entry of CORPUS) {
    describe(`[${entry.tag}] ${entry.name}`, () => {
      for (const expectation of entry.expectations) {
        const label = `${expectation.verdict} for request ${JSON.stringify(
          expectation.request,
        )}`;
        it(label, { timeout: 60_000 }, async () => {
          const { moduleSource, handlerSource } = renderProgram(
            entry.program,
            EXPRESS_TARGET,
          );
          const summary = await extractHandlerSummary(
            moduleSource,
            EXPRESS_TARGET.pack(),
          );
          const request = req(expectation.request);
          const execution = executeHandler(
            handlerSource,
            request,
            EXPRESS_TARGET.makeResponder,
          );
          if (execution.type === "error") {
            throw new Error(`harness failure: ${execution.message}`);
          }
          const mismatch = judgeObservation(
            summary,
            request,
            execution.observed.status,
          );

          if (expectation.verdict === "clean") {
            expect(
              mismatch,
              mismatch === null
                ? undefined
                : `expected a clean run but got ${mismatch.verdict}: ${mismatch.detail}`,
            ).toBeNull();
            return;
          }

          if (mismatch === null && entry.tag.startsWith("gap:")) {
            throw new Error(
              "documented gap no longer reproduces — if the underlying " +
                `extraction gap was fixed, flip this entry's verdict to ` +
                `"clean" and promote the construct's generator arm to the ` +
                `sound tier (entry: ${entry.name})`,
            );
          }
          expect(mismatch?.verdict).toBe(expectation.verdict);
        });
      }
    });
  }
});
