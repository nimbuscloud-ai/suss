// componentCorpus.test.ts — pinned render-boundary counterexamples.
//
// Same protocol as ../corpus.test.ts: every entry is a shrunk
// counterexample pinned as a (program, props, verdict) triple. `gap:*`
// entries assert a documented gap still reproduces; when extraction
// rework closes it, flip them to "clean".
//
// Corpus log:
// - 2026-07-30: nested null-guard captured from the first JSX fuzz
//   session — the outer `if` wrapping a guard is invisible to the
//   final render transition (same adapter machinery as the HTTP
//   nested-guard entries), so the render claims to be unconditional
//   while execution returns null.

import { describe, expect, it } from "vitest";

import reactFramework from "@suss/framework-react";

import { extractComponentSummary } from "../extract.js";
import {
  executeComponent,
  transpileComponentModule,
} from "./componentExecute.js";
import { judgeRenderObservation } from "./componentJudge.js";
import {
  type ComponentProgram,
  renderComponentModule,
} from "./componentProgram.js";

type ExpectedVerdict = "falseClaim" | "uncovered" | "clean";

interface ComponentCorpusEntry {
  name: string;
  tag: string;
  program: ComponentProgram;
  expectations: { props: Record<string, string>; verdict: ExpectedVerdict }[];
}

const truthyUser = {
  type: "truthy",
  prop: "user",
  negated: false,
} as const;

const CORPUS: ComponentCorpusEntry[] = [
  {
    name: "nested null-guard: outer if wrapping a guard is invisible to the final render",
    tag: "gap:nested-guard",
    // if (user) { if (user) { return null; } }  return <div/>;
    program: {
      props: ["user"],
      guards: [
        { type: "nestedGuardNull", outer: truthyUser, inner: truthyUser },
      ],
      root: { type: "element", tag: "div", children: [] },
    },
    expectations: [
      // Both guards fire → observed null, but the render transition
      // claims unconditional truth and cannot admit a null render.
      { props: { user: "a" }, verdict: "falseClaim" },
      { props: { user: "" }, verdict: "clean" },
    ],
  },
];

describe("component differential corpus", () => {
  for (const entry of CORPUS) {
    describe(`[${entry.tag}] ${entry.name}`, () => {
      for (const expectation of entry.expectations) {
        const label = `${expectation.verdict} for props ${JSON.stringify(
          expectation.props,
        )}`;
        it(label, { timeout: 60_000 }, async () => {
          const moduleSource = renderComponentModule(entry.program);
          const summary = await extractComponentSummary(
            moduleSource,
            reactFramework(),
          );
          const execution = executeComponent(
            transpileComponentModule(moduleSource),
            expectation.props,
          );
          if (execution.type === "error") {
            throw new Error(`harness failure: ${execution.message}`);
          }
          const mismatch = judgeRenderObservation(
            summary,
            expectation.props,
            execution.observed,
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
                `"clean" and fold the construct into the sound tier ` +
                `(entry: ${entry.name})`,
            );
          }
          expect(mismatch?.verdict).toBe(expectation.verdict);
        });
      }
    });
  }
});
