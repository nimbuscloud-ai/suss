/**
 * `suss ask` about a GraphQL field served by a graphql-ruby type, queried
 * by a React component through Apollo, with the schema dumped beside
 * both. `check` pairs the component's query with the field by reading
 * the query's document, and `ask` has to find the same caller.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

const FIXTURE = path.resolve(
  __dirname,
  "../../../fixtures/supervisor-listings",
);

let work: string;
let summaries: string;

async function quietly(
  args: string[],
  cwd = process.cwd(),
): Promise<{ exit: number; stdout: string }> {
  const out: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const origCwd = process.cwd();
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.chdir(cwd);
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join("") };
  } finally {
    process.chdir(origCwd);
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

interface AskAnswer {
  found: boolean;
  headline: string;
  items: Array<{ unit?: string; via?: string; boundary?: string }>;
  needs: string[];
}

const LISTING_CARD =
  "listings-app::web/listings/ListingCard.tsx::ListingCard.ListingCard";

async function ask(question: string): Promise<AskAnswer> {
  const run = await quietly(["ask", question, "--dir", summaries, "--json"]);
  return JSON.parse(run.stdout) as AskAnswer;
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-graphql-"));
  const project = path.join(work, "listings-app");
  fs.cpSync(FIXTURE, project, { recursive: true });
  summaries = path.join(work, "summaries");
  const run = await quietly(["extract", "--out-dir", summaries], project);
  expect(run.exit).toBe(0);
}, 120_000);

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("ask about a GraphQL field that a client query selects", () => {
  it("lists the query check pairs with the field as calling it", async () => {
    const answer = await ask("what calls gql:Query.listing");
    expect(answer.found).toBe(true);
    expect(answer.items).toEqual([
      expect.objectContaining({
        unit: LISTING_CARD,
        via: "query ListingCard",
      }),
    ]);
  });

  it("finds the component whose query selects the field as reaching it", async () => {
    const answer = await ask("what reaches gql:Query.listing");
    expect(answer.found).toBe(true);
    expect(answer.items).toEqual([
      expect.objectContaining({
        boundary: "function-call:react",
        unit: "listings-app::web/listings/ListingCard.tsx::ListingCard",
      }),
    ]);
  });

  it("reads the field's name as the code that serves it, and says the schema declares it too", async () => {
    const answer = await ask("what calls Query.listing");
    expect(answer.found).toBe(true);
    expect(answer.headline).toBe(
      "Nothing in these summaries calls app/graphql/types/query_type.rb::Query.listing#gql:Query.listing.",
    );
    expect(answer.needs).toEqual([
      "schema.graphql:Query.listing::Query.listing declares gql:Query.listing, which this code serves. suss ask 'what calls gql:Query.listing' lists the clients across it.",
    ]);
  });
});
