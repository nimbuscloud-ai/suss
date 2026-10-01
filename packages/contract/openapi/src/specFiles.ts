/**
 * Reads an OpenAPI document from disk along with every file its `$ref`s
 * reach, and rewrites each ref into the form the lookup in refs.ts expects.
 *
 * A document split across files writes each ref relative to the file the
 * ref is in, so `../../openapi.yaml#/components/parameters/Id` in
 * `paths/items/item.yaml` means the root document's `Id` parameter. The
 * rewrite turns that into `#/components/parameters/Id`, and a ref to a
 * third file into that file's path from the root document's directory.
 *
 * A ref with a URL scheme, such as `https:`, is left as written and never
 * fetched. A file that cannot be read is listed in `unreadable`, and the
 * refs into it stay unresolved.
 */

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { isReference, uriDecoded } from "./refs.js";

export interface SpecFiles {
  root: unknown;
  documents: Map<string, unknown>;
  unreadable: Array<{ file: string; reason: string }>;
}

/** Throws when the root file itself cannot be parsed. */
export function readSpecFiles(rootPath: string): SpecFiles {
  const rootDir = path.dirname(rootPath);
  const keyOf = (absolute: string): string =>
    absolute === rootPath
      ? ""
      : path.relative(rootDir, absolute).split(path.sep).join("/");

  const documents = new Map<string, unknown>();
  const unreadable: SpecFiles["unreadable"] = [];
  const queued = new Set<string>();
  const pending: string[] = [];

  const rewriteRefs = (document: unknown, documentKey: string): void => {
    const fromDir = path.resolve(rootDir, path.dirname(documentKey));
    const fileOf = (written: string): string =>
      written === ""
        ? documentKey
        : keyOf(path.resolve(fromDir, uriDecoded(written)));
    for (const holder of refHolders(document)) {
      const rewritten = rootRelativeRef(holder.$ref, fileOf);
      holder.$ref = rewritten.ref;
      if (rewritten.file !== "" && !queued.has(rewritten.file)) {
        queued.add(rewritten.file);
        pending.push(rewritten.file);
      }
    }
  };

  const root = parsedFile(rootPath);
  rewriteRefs(root, "");

  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const absolute = path.resolve(rootDir, next);
    const read = readReferencedFile(absolute);
    if (read.reason !== undefined) {
      unreadable.push({ file: next, reason: read.reason });
      continue;
    }
    rewriteRefs(read.value, next);
    documents.set(next, read.value);
  }

  return { root, documents, unreadable };
}

/** A `.json` file is parsed as JSON, and any other file as YAML, which also accepts JSON. */
function parsedFile(file: string): unknown {
  const raw = fs.readFileSync(file, "utf-8");
  return path.extname(file).toLowerCase() === ".json"
    ? JSON.parse(raw)
    : YAML.parse(raw);
}

function readReferencedFile(absolute: string): {
  value?: unknown;
  reason?: string;
} {
  if (!fs.existsSync(absolute)) {
    return { reason: "the file does not exist" };
  }
  try {
    return { value: parsedFile(absolute) };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

function rootRelativeRef(
  ref: string,
  fileOf: (written: string) => string,
): { ref: string; file: string } {
  if (/^[a-z][a-z\d+.-]*:/i.test(ref)) {
    return { ref, file: "" };
  }
  const hash = ref.indexOf("#");
  const file = fileOf(hash === -1 ? ref : ref.slice(0, hash));
  const fragment = hash === -1 ? "" : ref.slice(hash);
  return { ref: `${file}${fragment}`, file };
}

/**
 * Every object in the document with a string `$ref`, each once. YAML
 * anchors can make two places share one object, and rewriting a shared
 * ref twice would resolve it against the wrong directory the second time.
 */
function refHolders(document: unknown): Array<{ $ref: string }> {
  const holders: Array<{ $ref: string }> = [];
  const visited = new Set<object>();
  const stack: unknown[] = [document];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (typeof value !== "object" || value === null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isReference(value)) {
      holders.push(value);
    }
    for (const child of Object.values(value)) {
      stack.push(child);
    }
  }
  return holders;
}
