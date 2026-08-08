// document.ts: find and parse a Serverless Framework service file.
//
// The framework reads `serverless.yml`, `serverless.yaml`,
// `serverless.json` and `serverless.ts`, in that order, from the
// service directory. This reader handles the two YAML spellings and the
// JSON one. A `.ts` service file is a program, and running it to find
// out what it declares is not something a reader does.
//
// The `resources:` block contains raw CloudFormation, so the
// CloudFormation intrinsic tags are registered on the parse. A
// serverless.yml usually writes the full form (`Fn::GetAtt: [Q, Arn]`),
// but the short form is accepted there too.

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

/** In the framework's own order of preference. */
export const SERVICE_FILE_NAMES = [
  "serverless.yml",
  "serverless.yaml",
  "serverless.json",
] as const;

/** Recognized in order to be reported rather than read. */
export const PROGRAM_SERVICE_FILE_NAMES = [
  "serverless.ts",
  "serverless.js",
] as const;

export type ServiceLocation =
  | { kind: "readable"; file: string }
  | { kind: "program"; file: string }
  | { kind: "missing" };

/**
 * A path that points at a file is taken as that file. A directory is
 * searched parseable spellings first, so a service with both a yml and
 * a ts is read from the yml.
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
