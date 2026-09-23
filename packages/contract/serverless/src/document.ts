/**
 * Finding and parsing a Serverless Framework service file.
 *
 * The framework reads `serverless.yml`, `serverless.yaml`,
 * `serverless.json` and `serverless.ts`, in that order. This reader
 * parses the YAML and JSON files. A `.ts` or `.js` service file is a
 * program, so the reader reports it and does not run it.
 *
 * The `resources:` block contains raw CloudFormation, so the parse
 * registers the CloudFormation intrinsic tags. A serverless.yml usually
 * writes the full form (`Fn::GetAtt: [Q, Arn]`), and the short form
 * works too.
 */

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { CLOUDFORMATION_YAML_TAGS } from "@suss/manifest-aws";

/** One entry in a function's `events` list, as written. */
export type ServerlessEvent = Record<string, unknown>;

/** One entry of the `functions` block, as written. */
export interface ServerlessFunctionDefinition {
  handler?: unknown;
  environment?: unknown;
  runtime?: unknown;
  events?: unknown;
  name?: unknown;
}

export interface ServerlessDocument {
  service?: unknown;
  provider?: Record<string, unknown>;
  functions?: Record<string, ServerlessFunctionDefinition>;
  custom?: Record<string, unknown>;
  plugins?: unknown;
  /** Raw CloudFormation, in the framework's `{ Resources, Outputs }` shape. */
  resources?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The parseable service file names, in the framework's order of preference. */
export const SERVICE_FILE_NAMES = [
  "serverless.yml",
  "serverless.yaml",
  "serverless.json",
] as const;

/** Service files that are programs. The reader reports these and does not run them. */
export const PROGRAM_SERVICE_FILE_NAMES = [
  "serverless.ts",
  "serverless.js",
] as const;

export type ServiceLocation =
  | { kind: "readable"; file: string }
  | { kind: "program"; file: string }
  | { kind: "missing" };

/**
 * A path to a file is used as it is. A directory is searched for the
 * parseable files first, so a service with both a yml and a ts file is
 * read from the yml.
 */
export function locateServiceFile(candidate: string): ServiceLocation {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    return { kind: "missing" };
  }
  if (fs.statSync(resolved).isFile()) {
    return isProgram(resolved)
      ? { kind: "program", file: resolved }
      : { kind: "readable", file: resolved };
  }
  for (const name of SERVICE_FILE_NAMES) {
    const file = path.join(resolved, name);
    if (fs.existsSync(file)) {
      return { kind: "readable", file };
    }
  }
  for (const name of PROGRAM_SERVICE_FILE_NAMES) {
    const file = path.join(resolved, name);
    if (fs.existsSync(file)) {
      return { kind: "program", file };
    }
  }

  return { kind: "missing" };
}

function isProgram(file: string): boolean {
  const name = path.basename(file);

  return (PROGRAM_SERVICE_FILE_NAMES as readonly string[]).includes(name);
}

/** Null when the path contains no service file this reader can parse. */
export function findServiceFile(candidate: string): string | null {
  const located = locateServiceFile(candidate);

  return located.kind === "readable" ? located.file : null;
}

/** Throws when the file is missing or does not parse to an object. */
export function loadServerlessDocument(
  servicePath: string,
): ServerlessDocument {
  const file = findServiceFile(servicePath);
  if (file === null) {
    throw new Error(`Serverless service file not found: ${servicePath}`);
  }
  const raw = fs.readFileSync(file, "utf-8");
  const parsed: unknown = file.endsWith(".json")
    ? JSON.parse(raw)
    : YAML.parse(raw, { customTags: CLOUDFORMATION_YAML_TAGS });
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Serverless service file is not an object: ${file}`);
  }

  return parsed as ServerlessDocument;
}
