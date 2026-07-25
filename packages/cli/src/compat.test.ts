// compat.test.ts — the same service, written seven ways.
//
// Before suss goes out, it has to hold up against the shapes a
// TypeScript project actually takes: JavaScript as well as TypeScript,
// CommonJS as well as ESM, a tsconfig that inherits from a base, the
// "bundler" resolution every esbuild and Vite project uses, a helper
// described by a sibling .d.ts, and a dependency that is not installed
// and that suss knows nothing about.
//
// Each fixture under fixtures/compat/ is the same one-route service:
// GET /things/{id} answering 400 when the id is missing and 200
// otherwise, with the envelope built by a local `json(status, payload)`
// helper. One expectation covers all of them, so a case that drifts
// shows up as a difference from its siblings rather than as a bespoke
// assertion nobody reads.
//
// None of these projects has node_modules. That is deliberate: a
// checkout without an install is the state a new user is in, and the
// aws-lambda pack matches on import text, so it has to keep working
// there.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extract } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/compat",
);

/** Every case in the matrix, and what makes it worth covering. */
const CASES = [
  { dir: "ts-esm", what: "TypeScript over ESM" },
  { dir: "js-esm", what: "plain JavaScript through allowJs" },
  { dir: "cjs", what: "CommonJS" },
  { dir: "extended-tsconfig", what: "a tsconfig inheriting from a base" },
  { dir: "bundler", what: 'moduleResolution "bundler"' },
  { dir: "separate-dts", what: "a .js helper described by a sibling .d.ts" },
  { dir: "untyped-external", what: "an uninstalled, undescribed dependency" },
];

async function extractCase(dir: string): Promise<BehavioralSummary[]> {
  return await extract({
    tsconfig: path.join(FIXTURES, dir, "tsconfig.json"),
    frameworks: ["aws-lambda"],
    // Each run reads a different project, and a stale manifest would
    // hide a case that stopped working.
    noCache: true,
  });
}

function restBoundaries(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter(
    (s) => s.identity.boundaryBinding?.semantics.name === "rest",
  );
}

describe.each(CASES)("$what", ({ dir }) => {
  it("finds the route the template declares", async () => {
    const boundaries = restBoundaries(await extractCase(dir));

    expect(boundaries).toHaveLength(1);
    const semantics = boundaries[0]?.identity.boundaryBinding?.semantics;
    expect(semantics).toMatchObject({
      name: "rest",
      method: "GET",
      path: "/things/{id}",
    });
  });

  it("reads both statuses through the project's own helper", async () => {
    const boundaries = restBoundaries(await extractCase(dir));
    const statuses = (boundaries[0]?.transitions ?? [])
      .map((t) => (t.output.type === "response" ? t.output.statusCode : null))
      .map((code) => (code?.type === "literal" ? code.value : code?.type))
      .sort();

    // The helper takes (statusCode, payload). Reading it the other way
    // round would report the payload as the status, which is what this
    // whole matrix exists to catch.
    expect(statuses).toEqual([200, 400]);
  });

  it("reads the body shape on the success path", async () => {
    const boundaries = restBoundaries(await extractCase(dir));
    const ok = (boundaries[0]?.transitions ?? []).find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 200,
    );

    const body = ok?.output.type === "response" ? ok.output.body : null;
    expect(body).not.toBeNull();
    // `id` is known in every case. `name` comes from a library call in
    // the untyped-external case, where its type is unknowable, so only
    // the field's presence is asserted.
    expect(
      Object.keys((body as { properties?: object })?.properties ?? {}),
    ).toEqual(expect.arrayContaining(["id", "name"]));
  });
});

describe("a dependency suss knows nothing about", () => {
  it("does not stop the handler's own branches coming through", async () => {
    // The point of the case: `lookup` is unresolvable, and the handler's
    // guard and success path are still both described. Degrading on one
    // unknown call must not cost the whole summary.
    const boundaries = restBoundaries(await extractCase("untyped-external"));
    expect(boundaries[0]?.transitions).toHaveLength(2);
  });
});
