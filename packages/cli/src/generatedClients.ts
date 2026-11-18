/**
 * Clients that OpenAPI Generator wrote into a project, and how to tell
 * which document each one was generated from.
 *
 * A project that calls another team's service often checks in a client
 * generated from that service's OpenAPI document, such as a Ruby gem
 * under `vendor` that the Gemfile loads by path. `init` uses this to
 * list the document as the contract of a service the code calls. The
 * generator leaves a `.openapi-generator` folder at the top of what it
 * wrote, with a `FILES` list, and starts each file with a comment that
 * repeats the document's title. The title is how a client is matched
 * with its document. Nothing here runs the generator.
 */

import fs from "node:fs";
import path from "node:path";

import { isSkippedDirectory } from "./language.js";
import {
  headOf,
  PROJECT_WALK_DEPTH,
  TEST_DIRECTORIES,
} from "./projectSource.js";

const MARKER = ".openapi-generator";
const HEADER_BYTES = 2048;
/** How many of a client's files are tried before it counts as unmatched. */
const FILES_TRIED = 20;
/** What Bundler installs under `vendor`, as opposed to a gem checked in there. */
const VENDOR_INSTALLS = new Set(["bundle", "cache"]);

export interface GeneratedClient {
  /** The folder the generator wrote, relative to the project. */
  directory: string;
  /** Each line of its files' generated comment, without the comment marks. */
  header: ReadonlySet<string>;
}

export function generatedClientsUnder(root: string): GeneratedClient[] {
  return [...outputFolders(root, 0)].map((folder) => ({
    directory: path.relative(root, folder) || ".",
    header: headerOf(folder),
  }));
}

/** The client a document with this title was generated into, if one is here. */
export function clientGeneratedFrom(
  clients: readonly GeneratedClient[],
  title: string,
): GeneratedClient | undefined {
  return clients.find((client) => client.header.has(title));
}

function* outputFolders(dir: string, depth: number): Generator<string> {
  if (depth > PROJECT_WALK_DEPTH) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === MARKER)) {
    yield dir;
    return;
  }

  const parent = path.basename(dir);
  for (const entry of entries) {
    if (entry.isDirectory() && walksInto(entry.name, parent)) {
      yield* outputFolders(path.join(dir, entry.name), depth + 1);
    }
  }
}

/**
 * The source walk leaves `vendor` out for the gems Bundler installs in
 * it, and a path gem is checked in beside them, so this walk goes in.
 */
function walksInto(name: string, parent: string): boolean {
  if (name === "vendor") {
    return true;
  }

  if (parent === "vendor" && VENDOR_INSTALLS.has(name)) {
    return false;
  }
  return !isSkippedDirectory(name) && !TEST_DIRECTORIES.has(name);
}

function headerOf(folder: string): Set<string> {
  for (const file of listedFiles(folder).slice(0, FILES_TRIED)) {
    const head = headOf(path.join(folder, file), HEADER_BYTES);
    if (/openapi.generator/i.test(head)) {
      return new Set(
        head
          .split("\n")
          .map(withoutCommentMarks)
          .filter((line) => line !== ""),
      );
    }
  }
  return new Set();
}

function listedFiles(folder: string): string[] {
  let listed: string;
  try {
    listed = fs.readFileSync(path.join(folder, MARKER, "FILES"), "utf8");
  } catch {
    return [];
  }
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("."));
}

/** `#Ledger Service`, ` * Ledger Service` and `    Ledger Service` all give the title. */
function withoutCommentMarks(line: string): string {
  return line.replace(/^[\s#*/"]+/, "").trim();
}
