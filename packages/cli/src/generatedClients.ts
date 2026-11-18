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
/** The title is the first line of a file's generated comment, well inside this. */
const HEADER_BYTES = 2048;
/** How many of a client's code files are read for the title. */
const FILES_TRIED = 20;
/** How deep the walk goes in a client that has no `FILES` list. */
const WALK_DEPTH = 4;
/** The languages suss reads, which are the ones a client here is worth matching for. */
const CODE_EXTENSIONS = new Set([
  ".rb",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
]);
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

/**
 * The lines at the top of the client's code files. The marker already
 * says the folder is generated, so nothing here looks for the
 * generator's own line, which comes after the document's description
 * and can be kilobytes down.
 */
function headerOf(folder: string): Set<string> {
  const lines = new Set<string>();
  for (const file of codeFilesOf(folder).slice(0, FILES_TRIED)) {
    for (const line of headOf(path.join(folder, file), HEADER_BYTES).split(
      "\n",
    )) {
      const text = withoutCommentMarks(line);
      if (text !== "") {
        lines.add(text);
      }
    }
  }
  return lines;
}

/**
 * The code files the generator wrote, in the order `FILES` lists them,
 * or found by a walk of the folder when it has no `FILES`. The list is
 * alphabetical, so a Ruby gem's dot files, README and dozens of
 * `docs/*.md` pages come before `lib/`, and the README has no line that
 * is the title alone.
 */
function codeFilesOf(folder: string): string[] {
  let listed: string[];
  try {
    listed = fs
      .readFileSync(path.join(folder, MARKER, "FILES"), "utf8")
      .split("\n")
      .map((line) => line.trim());
  } catch {
    listed = [...filesBelow(folder, "", 0)];
  }
  return listed.filter(isClientCode);
}

function* filesBelow(
  folder: string,
  relative: string,
  depth: number,
): Generator<string> {
  if (depth > WALK_DEPTH) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(folder, relative), {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const at = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      yield* filesBelow(folder, at, depth + 1);
      continue;
    }
    yield at;
  }
}

function isClientCode(file: string): boolean {
  return (
    CODE_EXTENSIONS.has(path.extname(file)) &&
    file.split("/").every((segment) => !segment.startsWith("."))
  );
}

/** `#Ledger Service`, ` * Ledger Service` and `    Ledger Service` all give the title. */
function withoutCommentMarks(line: string): string {
  return line.replace(/^[\s#*/"]+/, "").trim();
}
