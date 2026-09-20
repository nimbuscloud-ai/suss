/**
 * Reading a client class once per construction site, in the three
 * languages, on the two shapes that made 0.31.0 slow.
 *
 * One class builds every URL in a single method out of its base and the
 * endpoint it was passed, so ten methods share one client call. The
 * other is built inside an async factory out of an awaited config
 * value, which is the shape whose per-site question never settled.
 *
 * Each language asserts the same four things: the paths come out per
 * site, no question was given up on, and neither one question nor the
 * whole run read more rows than the bounds below.
 */

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { type EvaluationProfile, profileEvaluationAsync } from "@suss/datalog";
import axiosPack from "@suss/packs/axios";
import faradayClient from "@suss/packs/faraday";
import requestsClient from "@suss/packs/requests";
import { createFixtureProject } from "@suss/test-project";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixtures = path.resolve(__dirname, "../../../fixtures");

/** Every REST path the summaries claim, as "METHOD path", deduplicated and sorted. */
function restPaths(summaries: BehavioralSummary[]): string[] {
  const paths = new Set<string>();
  for (const summary of summaries) {
    const semantics = summary.identity.boundaryBinding?.semantics;
    if (semantics?.name === "rest") {
      paths.add(`${semantics.method} ${semantics.path}`);
    }
  }
  return [...paths].sort();
}

const CATALOG_PATHS = [
  "brands",
  "bundles",
  "categories",
  "collections",
  "prices",
  "products",
  "reviews",
  "stock",
  "tags",
  "variants",
];

/**
 * What every language claims about the fixture.
 *
 * The method that builds the URL is read once per construction site, so
 * its base comes out as the literal that site passed and the endpoint
 * it was handed stays a hole. Filling in both halves at once would need
 * the ten calling methods read under each site as well, which no
 * version has done.
 */
const PER_SITE_PATHS = [
  "GET /store/{endpoint}",
  "GET /warehouse/{endpoint}",
  "GET /reports/daily",
];

/**
 * The ten methods that call it, read without a site, so each keeps its
 * own literal endpoint over a hole where the base goes. Only the
 * TypeScript adapter discovers a method whose request goes through
 * another method of its own class.
 */
const CONTEXT_FREE_PATHS = CATALOG_PATHS.map((one) => `GET {baseUrl}/${one}`);

interface Run {
  summaries: BehavioralSummary[];
  profile: EvaluationProfile;
}

async function typescriptRun(): Promise<Run> {
  const { result, profile } = await profileEvaluationAsync(async () => {
    const adapter = createTypeScriptAdapter({
      project: createFixtureProject(
        path.join(fixtures, "per-site-client"),
        "*.ts",
      ),
      frameworks: [axiosPack()],
      cacheDir: null,
    });
    return adapter.extractAll();
  });
  return { summaries: result, profile };
}

async function pythonRun(): Promise<Run> {
  const root = path.join(fixtures, "per-site-client-python");
  const { result, profile } = await profileEvaluationAsync(async () => {
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(root),
      packs: [requestsClient()],
      roots: [root],
      workspaceRoot: root,
      cacheDir: null,
    });
    return summaries;
  });
  return { summaries: result, profile };
}

async function rubyRun(): Promise<Run> {
  const root = path.join(fixtures, "per-site-client-ruby");
  const { result, profile } = await profileEvaluationAsync(async () => {
    const { summaries } = await extractRubyProject({
      files: findRubyFiles(root),
      packs: [faradayClient()],
      workspaceRoot: root,
      cacheDir: null,
    });
    return summaries;
  });
  return { summaries: result, profile };
}

interface Language {
  name: string;
  run: () => Promise<Run>;
  paths: string[];
  /** Rows the whole run may read, about three times what it reads today. */
  rowBound: number;
  /** Rows one question may read, about three times the biggest one today. */
  questionBound: number;
  /** Times the rules may be evaluated, a little over what the run takes today. Asking per call site rather than per file blows straight through it. */
  evaluationBound: number;
}

// The counts are the same on every machine, so the bounds can be close
// to what the fixtures read. Python asks far bigger questions than the
// other two of the same shape, which is its own thing to chase.
const LANGUAGES: Language[] = [
  {
    name: "TypeScript",
    run: typescriptRun,
    paths: [...PER_SITE_PATHS, ...CONTEXT_FREE_PATHS].sort(),
    rowBound: 200_000,
    questionBound: 20_000,
    evaluationBound: 120,
  },
  {
    name: "Python",
    run: pythonRun,
    paths: [...PER_SITE_PATHS, "GET /config"].sort(),
    rowBound: 7_000_000,
    questionBound: 1_800_000,
    evaluationBound: 25,
  },
  {
    name: "Ruby",
    run: rubyRun,
    paths: [...PER_SITE_PATHS, "GET /config"].sort(),
    rowBound: 60_000,
    questionBound: 30_000,
    // Ruby runs the rules 18 times here either way: four files is too
    // few for the per-file batch to show. `clientCalls.test.ts` is
    // where adding call sites has to stop adding questions.
    evaluationBound: 20,
  },
];

describe.each(LANGUAGES)(
  "a client class read per construction site in $name",
  ({ run, paths, rowBound, questionBound, evaluationBound }) => {
    let extracted: Run;

    beforeAll(async () => {
      extracted = await run();
    }, 120_000);

    it("reads every path under both bases", () => {
      expect(restPaths(extracted.summaries)).toEqual(paths);
    });

    it("finishes every question it asks", () => {
      expect(extracted.profile.abandoned).toEqual([]);
    });

    it("reads fewer rows for one question than the bound", () => {
      expect(extracted.profile.largestEvaluation).toBeLessThan(questionBound);
    });

    it("reads fewer rows over the whole run than the bound", () => {
      expect(extracted.profile.examined).toBeLessThan(rowBound);
    });

    it("evaluates the rules fewer times than the bound", () => {
      expect(extracted.profile.evaluations).toBeLessThan(evaluationBound);
    });
  },
);
