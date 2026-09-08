/**
 * packTables.mjs: the pack rows on the packages page, built from what
 * each pack declares about itself.
 *
 * A pack states its kind and a sentence about what it reads beside its
 * own patterns, `suss init` reads the same declaration to suggest it,
 * and the table here is the third reader. Before this the sentence was
 * typed twice, once in the pack and once in the document, and the two
 * drifted apart a release after a pack arrived.
 *
 * Used by generatePackTables.mjs to write the tables and to check them.
 */

import fs from "node:fs";
import path from "node:path";

import { coveragePackages } from "./coverage-packages.mjs";
import { findManifests, PACKAGES_DIR } from "./workspacePackages.mjs";

const REPO_ROOT = path.join(PACKAGES_DIR, "..");

/** The `-f` names and the package behind each, in the CLI's own order. */
function builtinPacks() {
  const extract = fs.readFileSync(
    path.join(PACKAGES_DIR, "cli", "src", "extract.ts"),
    "utf8",
  );
  const entries = [
    ...extract.matchAll(/^\s*"?([\w-]+)"?:\s*"@suss\/packs\/[\w-]+",$/gm),
  ].map(([, name]) => name);

  const directoryByPackage = new Map(
    findManifests().map((file) => [
      JSON.parse(fs.readFileSync(file, "utf8")).name,
      path.relative(REPO_ROOT, path.dirname(file)),
    ]),
  );
  const badgeByDirectory = new Map(coveragePackages);

  return entries.map((name) => {
    const entry = fs.readFileSync(
      path.join(PACKAGES_DIR, "packs", "src", `${name}.ts`),
      "utf8",
    );
    const packageName = /from "(@suss\/[\w-]+)"/.exec(entry)?.[1];
    const directory = directoryByPackage.get(packageName);
    if (directory === undefined) {
      throw new Error(
        `-f ${name} re-exports ${packageName}, which is not here`,
      );
    }

    return {
      name,
      packageName,
      directory,
      badge: badgeByDirectory.get(directory),
      declares: declarationIn(path.join(REPO_ROOT, directory)),
    };
  });
}

/**
 * What a pack declares, read out of its source. Importing the built
 * bundle would say the same thing and would make writing a document
 * wait on a build.
 */
function declarationIn(directory) {
  const source = fs.readFileSync(path.join(directory, "src/index.ts"), "utf8");
  const block =
    /export const declares: PackDeclaration = \{([\s\S]*?)\n\};/.exec(
      source,
    )?.[1];
  if (block === undefined) {
    throw new Error(`${directory} exports no declares`);
  }

  const kind = /\n {2}kind: "(\w+)"/.exec(block)?.[1];
  // A sentence with a double quote in it is written as a template
  // literal, and one with a backtick escapes the backtick.
  const quoted = /\n {2}reads:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
  const templated = /\n {2}reads:\s*`((?:[^`\\]|\\.)*)`/.exec(block)?.[1];
  const reads = (quoted ?? templated)?.replaceAll("\\`", "`");
  if (kind === undefined || reads === undefined) {
    throw new Error(`${directory} declares no kind or no reads line`);
  }

  return { kind, reads };
}

const row = (pack) =>
  `| [\`${pack.name}\`](../../${pack.directory}) | ${pack.declares.reads} | ![](../../.github/badges/coverage-${pack.badge}.svg) |`;

const HEADER = ["| Name | What it reads | Coverage |", "|---|---|---|"];

/**
 * One table per kind, keyed by the marker it goes between. A reader
 * comes to this page with a library in mind, so the rows are in
 * alphabetical order rather than the order the CLI happens to list them
 * in.
 */
export function packTables() {
  const packs = builtinPacks();
  const tableFor = (kind) =>
    [
      ...HEADER,
      ...packs
        .filter((pack) => pack.declares.kind === kind)
        .sort((one, other) => one.name.localeCompare(other.name))
        .map(row),
    ].join("\n");

  return {
    framework: tableFor("framework"),
    client: tableFor("client"),
    effects: tableFor("effects"),
  };
}

export const marker = (kind) => ({
  start: `<!-- generated from what each pack declares: ${kind} -->`,
  end: `<!-- end ${kind} -->`,
});
