/**
 * A GraphQL field renamed across a graphql-ruby type and the React
 * component whose query selects it, read with `extract --out-dir` before
 * and after. The checked-in schema still declares the old name, as it
 * does when nobody has dumped it again.
 *
 * The component's outcome reads `render <article />  otherwise` on both
 * sides, so the diff has to say where inside the render tree it moved.
 * The change list tests spell the field without its protocol.
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
let project: string;
const snapshots = { before: "", after: "" };

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-graphql-rename-"));
  project = path.join(work, "listings-app");
  fs.cpSync(FIXTURE, project, { recursive: true });

  snapshots.before = await snapshot("before");
  edit(
    "app/graphql/types/listing_type.rb",
    "field :short_desc, String, null: true",
    "field :short_description, String, null: true, method: :short_desc",
  );
  edit(
    "web/listings/ListingCard.tsx",
    "      shortDesc\n",
    "      shortDescription\n",
  );
  edit(
    "web/listings/ListingCard.tsx",
    "{data?.listing?.shortDesc}",
    "{data?.listing?.shortDescription}",
  );
  snapshots.after = await snapshot("after");
}, 120_000);

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function edit(file: string, from: string, to: string): void {
  const at = path.join(project, file);
  const text = fs.readFileSync(at, "utf8");
  expect(text).toContain(from);
  fs.writeFileSync(at, text.replace(from, to));
}

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

async function snapshot(name: string): Promise<string> {
  const dir = path.join(work, name);
  const run = await quietly(["extract", "--out-dir", dir], project);
  expect(run.exit).toBe(0);
  return dir;
}

async function changeList(yaml: string): Promise<string> {
  const file = path.join(work, "changes.yaml");
  fs.writeFileSync(file, yaml);
  const run = await quietly([
    "intent",
    "check",
    file,
    "--before",
    snapshots.before,
    "--after",
    snapshots.after,
  ]);
  return run.stdout;
}

describe("inspect --diff after a field rename", () => {
  it("says where the component's render tree reads the new name, on one line", async () => {
    const run = await quietly([
      "inspect",
      "--diff",
      snapshots.before,
      snapshots.after,
    ]);

    expect(run.stdout).toContain(
      [
        "  ~ ListingCard",
        "      ~ render <article />  otherwise",
        '        output.root.children[1].children[0].sourceText: "data?.listing?.shortDesc" -> "data?.listing?.shortDescription"',
      ].join("\n"),
    );
    expect(run.stdout).not.toContain("was  render");
    expect(run.stdout).not.toContain('{"type":');
  });

  it("says the query selects the field under its new name", async () => {
    const run = await quietly([
      "inspect",
      "--diff",
      snapshots.before,
      snapshots.after,
    ]);

    expect(run.stdout).toContain(
      [
        "~ calls query ListingCard  web/listings/ListingCard.tsx::ListingCard.ListingCard",
        "  outcomes",
        "    ~ return  otherwise",
        "      expectedInput...listing.properties.shortDesc renamed to shortDescription",
      ].join("\n"),
    );
  });

  it("writes the same lines in the JSON, with no was line to compare", async () => {
    const run = await quietly([
      "inspect",
      "--diff",
      snapshots.before,
      snapshots.after,
      "--json",
    ]);
    const query = JSON.parse(run.stdout).boundaries.find(
      (block: { boundary: string }) => block.boundary === "query ListingCard",
    );

    expect(query.outcomes).toEqual([
      {
        change: "changed",
        outcome: "return  otherwise",
        fields: [
          "expectedInput...listing.properties.shortDesc renamed to shortDescription",
        ],
      },
    ]);
  });
});

describe("intent check with the field spelled without its protocol", () => {
  it("counts the rename done when the list removes the old field and adds the new one", async () => {
    const said = await changeList(
      [
        "changes:",
        "  - removes: Listing.shortDesc",
        "  - adds: Listing.shortDescription",
        "  - changes: query ListingCard",
      ].join("\n"),
    );

    expect(said).toBe(
      [
        "3 done.",
        "",
        "done        - gql:Listing.shortDesc  app/graphql/types/listing_type.rb::Listing.shortDesc",
        "            + gql:Listing.shortDescription  app/graphql/types/listing_type.rb::Listing.shortDescription",
        "            ~ query ListingCard  web/listings/ListingCard.tsx::ListingCard.ListingCard",
        "",
      ].join("\n"),
    );
  });

  it("says how to write the rename when the list says the old field changes", async () => {
    const said = await changeList(
      [
        "changes:",
        "  - changes: Listing.shortDesc",
        "    note: renamed to shortDescription",
      ].join("\n"),
    );

    expect(said).toContain(
      [
        "not done    ~ gql:Listing.shortDesc renamed to shortDescription",
        "              the diff shows gql:Listing.shortDesc removed. A rename is a removes entry for the old name and an adds entry for the new one.",
      ].join("\n"),
    );
  });

  it("lists what a bare type name could mean", async () => {
    const said = await changeList(
      ["changes:", "  - changes: Listing"].join("\n"),
    );

    expect(said).toContain(
      "Listing could mean 5 boundaries here: gql:Listing.id, gql:Listing.shortDesc, gql:Listing.shortDescription, gql:Listing.title, gql:Query.listing, so suss cannot check this entry.",
    );
  });
});
