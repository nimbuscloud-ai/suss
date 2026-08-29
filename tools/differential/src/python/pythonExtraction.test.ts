// pythonExtraction.test.ts: the static half of the Python
// differential, run per pull request without an interpreter.
//
// The full adjudication (claims against a running app) lives in
// fuzzPython.mjs and the scheduled fuzz workflow, because the runtime
// side needs python3 and the target frameworks. What CI can hold on
// every pull request is the tier boundary itself: over a fixed-seed
// sample, every claim-tier intent extracts to a claim of exactly its
// served path, and every abstention-tier intent extracts to no path
// claim at all. If a pack change moves a shape across that line, this
// fails and says to move the shape's tier in the generator, the same
// promotion protocol the TypeScript shape families follow.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { fastapiFramework } from "@suss/framework-fastapi";
import { flaskRestxFramework } from "@suss/framework-flask-restx";

import { arbPythonProgramSpec } from "./pythonGenerators.js";
import { readSummaryClaims } from "./pythonJudge.js";
import { renderPythonProgram } from "./pythonProgram.js";

import type { PythonPack } from "@suss/adapter-python";
import type { RenderedPythonProgram } from "./pythonProgram.js";

const SAMPLED = fc.sample(arbPythonProgramSpec, {
  numRuns: 24,
  seed: 20260806,
});

const workDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "suss-differential-python-static-"),
);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function packsFor(rendered: RenderedPythonProgram): PythonPack[] {
  if (rendered.framework === "fastapi") {
    return [fastapiFramework()];
  }
  return [flaskRestxFramework({ wrapperModules: rendered.wrapperModules })];
}

describe("python extraction over generated programs", () => {
  it(
    "claim-tier intents extract to their served path; abstention-tier intents extract to no path claim",
    { timeout: 120_000 },
    async () => {
      for (const [i, spec] of SAMPLED.entries()) {
        const rendered = renderPythonProgram(spec, `app_${i}`);
        const programDir = path.join(workDir, `prog_${i}`);
        const files: string[] = [];
        for (const [relative, content] of Object.entries(rendered.files)) {
          const filePath = path.join(programDir, relative);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content);
          files.push(filePath);
        }

        const { summaries } = await extractPythonProject({
          files: files.sort(),
          packs: packsFor(rendered),
          roots: [programDir],
        });
        const { claims } = readSummaryClaims(summaries);
        const claimsByName = new Map<string, typeof claims>();
        for (const claim of claims) {
          const list = claimsByName.get(claim.name) ?? [];
          list.push(claim);
          claimsByName.set(claim.name, list);
        }

        for (const intent of rendered.intents) {
          const named = claimsByName.get(intent.name) ?? [];
          if (intent.expectation === "claim") {
            expect
              .soft(
                named[0],
                `${intent.name} is a shape the pack reads today and it extracted no path claim`,
              )
              .toBeDefined();
            if (named.length > 0) {
              for (const claim of named) {
                expect(claim.method).toBe(intent.method);
              }
              // A route served under several mounts claims one boundary
              // per mount, so the claim set is the served set.
              expect(new Set(named.map((claim) => claim.path)).size).toBe(
                named.length,
              );
              expect([...named.map((claim) => claim.path)].sort()).toEqual(
                [...intent.servedPaths].sort(),
              );
            }
            continue;
          }
          expect
            .soft(
              named[0],
              `${intent.name} is a documented abstention shape and it now extracts a path claim; if the pack learned to read it, move the shape to the claim tier in the generator`,
            )
            .toBeUndefined();
        }
      }
    },
  );
});
