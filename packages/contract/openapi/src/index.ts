// Reads an OpenAPI 3.x or Swagger 2.0 document into one handler summary
// per operation.

import fs from "node:fs";
import path from "node:path";

import { readSpecFiles } from "./specFiles.js";
import { specToSummaries } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "./spec.js";
import type { SpecFiles } from "./specFiles.js";

export interface OpenApiToSummariesOptions {
  /** The source label recorded on each summary, in place of the default. */
  source?: string;
}

export interface OpenApiFileToSummariesOptions
  extends OpenApiToSummariesOptions {
  /**
   * Collects each file a `$ref` points to that could not be read, and each
   * ref that points at nothing. Without it, each goes to stderr.
   */
  warnings?: string[];
}

/** More unresolved refs than this are counted rather than listed. */
const UNRESOLVED_LISTED = 10;

/**
 * Converts an OpenAPI document already in memory. Each operation becomes
 * one summary with one transition per declared response status. A `$ref`
 * inside the document is resolved, and a recursive one stops at a `ref`.
 * A ref to another file is left unresolved, because a document in memory
 * has no directory to look in; read it with `openApiFileToSummaries`.
 */
export function openApiToSummaries(
  spec: OpenApiSpec,
  options: OpenApiToSummariesOptions = {},
): BehavioralSummary[] {
  return specToSummaries(spec, options);
}

/**
 * Reads an OpenAPI document from a YAML or JSON file and converts it,
 * along with every file its `$ref`s reach, each resolved relative to the
 * file the ref is in. A `.json` file is parsed as JSON, and any other file
 * goes through the YAML parser, which also accepts JSON. Throws when the
 * file is missing or does not contain an object.
 */
export function openApiFileToSummaries(
  specPath: string,
  options: OpenApiFileToSummariesOptions = {},
): BehavioralSummary[] {
  const resolved = path.resolve(specPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`OpenAPI spec not found: ${resolved}`);
  }
  const files = readSpecFiles(resolved);
  if (files.root === null || typeof files.root !== "object") {
    throw new Error(`OpenAPI spec is not an object: ${resolved}`);
  }
  const unresolved = new Set<string>();
  const summaries = specToSummaries(files.root as OpenApiSpec, {
    source: options.source ?? `openapi:${path.basename(resolved)}`,
    documents: files.documents,
    unresolved,
  });
  const messages = unreadMessages(specPath, files, unresolved);
  if (options.warnings !== undefined) {
    options.warnings.push(...messages);
    return summaries;
  }

  for (const message of messages) {
    process.stderr.write(`[suss] openapi: ${message}\n`);
  }
  return summaries;
}

/**
 * A file that could not be read is reported once, and the refs into it
 * are left out of the list of refs that point at nothing.
 */
function unreadMessages(
  specPath: string,
  files: SpecFiles,
  unresolved: ReadonlySet<string>,
): string[] {
  const messages = files.unreadable.map(
    ({ file, reason }) =>
      `${specPath}: could not read ${file}, which a $ref points to: ${reason}`,
  );
  const missingFiles = new Set(files.unreadable.map(({ file }) => file));
  const dangling = [...unresolved].filter(
    (ref) => !missingFiles.has(ref.split("#")[0]),
  );
  for (const ref of dangling.slice(0, UNRESOLVED_LISTED)) {
    messages.push(`${specPath}: $ref ${ref} points at nothing`);
  }
  if (dangling.length > UNRESOLVED_LISTED) {
    messages.push(
      `${specPath}: ${dangling.length - UNRESOLVED_LISTED} more $refs point at nothing`,
    );
  }
  return messages;
}

export type { OpenApiSpec, Reference } from "./spec.js";
