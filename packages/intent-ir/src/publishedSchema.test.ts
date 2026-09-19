// A preprocess and a refine have no JSON Schema spelling, so the
// published schema and IntentDocSchema can drift apart. These run both
// over the same documents.

import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { IntentDocSchema } from "./schema.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

const published = JSON.parse(
  fs.readFileSync(
    path.join(PACKAGE_ROOT, "schema", "intent-doc.schema.json"),
    "utf-8",
  ),
);

// Off, so ajv takes a keyword it has no opinion about.
const validate = new Ajv2020.default({ strict: false }).compile(published);

/** Every intent document this repository keeps, as parsed YAML. */
function repoDocuments(): Array<{ file: string; doc: unknown }> {
  const roots = [
    path.join(REPO_ROOT, "intent"),
    path.join(REPO_ROOT, "design", "proposals", "intent-layer-examples"),
  ];
  const found: Array<{ file: string; doc: unknown }> = [];
  for (const root of roots) {
    for (const file of yamlFilesUnder(root)) {
      found.push({
        file: path.relative(REPO_ROOT, file),
        doc: YAML.parse(fs.readFileSync(file, "utf-8")),
      });
    }
  }
  return found;
}

function yamlFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...yamlFilesUnder(full));
      continue;
    }

    if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
      out.push(full);
    }
  }
  return out.sort();
}

describe("the published JSON Schema", () => {
  it("takes a bare returns:, which YAML parses as null", () => {
    const doc = YAML.parse(`
kind: boundary
name: checker-check-pair
purpose: Run the checks for one summary pair.
audience: downstream-consumers
boundary:
  semantics: function-call
  package: "@suss/checker"
  exportPath: ["checkPair"]
transitions:
  - id: findings
    when: called with a provider summary and a consumer summary
    returns:
`);
    expect(doc.transitions[0].returns).toBeNull();
    expect(IntentDocSchema.safeParse(doc).success).toBe(true);
    expect(validate(doc)).toBe(true);
  });

  it("leaves no suss marker key in the published file", () => {
    expect(JSON.stringify(published)).not.toContain("x-suss-");
  });

  it("agrees with IntentDocSchema on every document in the repository", () => {
    const documents = repoDocuments();
    expect(documents.length).toBeGreaterThan(0);

    const verdicts = documents.map(({ file, doc }) => ({
      file,
      zod: IntentDocSchema.safeParse(doc).success,
      json: validate(doc) === true,
    }));
    expect(verdicts.filter((v) => v.zod !== v.json)).toEqual([]);
  });

  it("takes every document the loader is meant to read", () => {
    const loadable = repoDocuments().filter(({ file }) =>
      /\.(intent|prd)\.ya?ml$/.test(file),
    );
    expect(loadable.length).toBeGreaterThan(0);
    expect(
      loadable.filter(({ doc }) => !IntentDocSchema.safeParse(doc).success),
    ).toEqual([]);
  });
});
