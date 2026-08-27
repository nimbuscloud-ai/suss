// The spelling axis: every path position a pack declares, crossed with
// the ways the language writes one value.
//
// The invariant has two halves. A spelling the language settles gives
// the same answer as the literal. A spelling it does not settle gives
// an abstention: a pattern with a hole in it, or nothing claimed,
// never a concrete path the code does not state.

import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { axiosPack } from "@suss/client-axios";
import { webFetchPack } from "@suss/client-web";
import { expressFramework } from "@suss/framework-express";
import { fastifyFramework } from "@suss/framework-fastify";
import { honoFramework } from "@suss/framework-hono";
import { createTestProject } from "@suss/test-project";

import { SPELLINGS } from "./spellings.js";
import { valuePositionsOf } from "./valuePositions.js";

import type { PatternPack } from "@suss/extractor";
import type { ValuePosition } from "./valuePositions.js";

const VALUE = "/users/:id";

const PACKS: readonly PatternPack[] = [
  expressFramework(),
  fastifyFramework(),
  honoFramework(),
  webFetchPack(),
  axiosPack(),
];

/** Every rest path the run claims, hole spellings and all. */
async function pathsClaimed(
  position: ValuePosition,
  files: Readonly<Record<string, string>>,
  source: string,
): Promise<string[]> {
  const project = createTestProject();
  for (const [file, text] of Object.entries({ ...position.files, ...files })) {
    project.createSourceFile(file, text);
  }
  project.createSourceFile("/app/index.ts", source);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [position.pack],
  });
  const summaries = await adapter.extractAll();
  return summaries
    .map((one) => {
      const semantics = one.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest" ? semantics.path : null;
    })
    .filter((one): one is string => one !== null && one !== "");
}

const positions = PACKS.flatMap(valuePositionsOf);

describe("every declared path position, across the spellings of one value", () => {
  it("derives a position from every pack under test", () => {
    // A pack that stops declaring a path position leaves the matrix
    // silently, and this is what says so.
    expect(positions.length).toBeGreaterThanOrEqual(PACKS.length);
  });

  for (const position of positions) {
    describe(position.name, () => {
      for (const spelling of SPELLINGS) {
        it(spelling.name, async () => {
          const spelled = spelling.render(VALUE);
          const paths = await pathsClaimed(
            position,
            spelled.files,
            position.program(spelled),
          );

          if (spelling.settles) {
            const answer = spelling.answer?.(VALUE) ?? VALUE;
            expect(paths).toEqual([answer]);
            return;
          }

          // An unsettled spelling abstains: a pattern with a hole in
          // it, or nothing claimed. A concrete path here would be a
          // claim the code does not state.
          for (const path of paths) {
            expect(path).toContain("{");
          }
        });
      }
    });
  }
});
