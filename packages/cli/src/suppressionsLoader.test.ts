import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";
import { applySuppressions } from "@suss/checker";

import {
  findSuppressionsFile,
  loadSuppressions,
  suppressionsSearchDirs,
} from "./suppressionsLoader.js";

import type { Finding } from "@suss/behavioral-ir";
import type { SuppressionRule } from "@suss/checker";

let root: string;
let summaries: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "suss-supp-")));
  summaries = path.join(root, "summaries");
  fs.mkdirSync(summaries);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeIgnore(dir: string, reason: string): string {
  const file = path.join(dir, ".sussignore.yml");
  fs.writeFileSync(
    file,
    [
      "version: 1",
      "rules:",
      "  - kind: deadConsumerBranch",
      "    boundary: GET /users/{id}",
      `    reason: ${reason}`,
    ].join("\n"),
  );
  return file;
}

describe("suppressionsSearchDirs", () => {
  it("covers the starting directory and its parents up to the project root", () => {
    expect(suppressionsSearchDirs(summaries)).toEqual([summaries, root]);
  });

  it("stops at the nearest package.json rather than climbing past it", () => {
    const nested = path.join(root, "packages", "api");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "package.json"), "{}");
    expect(suppressionsSearchDirs(nested)).toEqual([nested]);
  });
});

describe("findSuppressionsFile", () => {
  it("finds a file at the project root when the summaries folder has none", () => {
    const file = writeIgnore(root, "at the project root");
    expect(findSuppressionsFile(summaries)).toBe(file);
  });

  it("prefers the file nearest the summaries folder", () => {
    writeIgnore(root, "at the project root");
    const near = writeIgnore(summaries, "next to the summaries");
    expect(findSuppressionsFile(summaries)).toBe(near);
  });

  it("returns null when no file exists anywhere up the chain", () => {
    expect(findSuppressionsFile(summaries)).toBeNull();
  });
});

describe("loadSuppressions", () => {
  it("names the missing version and the fix for it", () => {
    const file = path.join(root, ".sussignore.yml");
    fs.writeFileSync(
      file,
      [
        "rules:",
        "  - kind: deadConsumerBranch",
        "    boundary: GET /users/{id}",
        "    reason: copied out of the docs",
      ].join("\n"),
    );
    expect(() => loadSuppressions(file)).toThrow(/Add `version: 1`/);
  });

  it("reads a provider-side rule", () => {
    const file = path.join(root, ".sussignore.yml");
    fs.writeFileSync(
      file,
      [
        "version: 1",
        "rules:",
        "  - kind: unhandledProviderCase",
        '    provider: { transitionId: "get:response:410:3b915da" }',
        "    reason: the caller retries anything unexpected",
      ].join("\n"),
    );
    expect(loadSuppressions(file)[0].provider).toEqual({
      transitionId: "get:response:410:3b915da",
    });
  });

  it("says when a rule names a document the way readers used to label them", () => {
    const file = path.join(root, ".sussignore.yml");
    fs.writeFileSync(
      file,
      [
        "version: 1",
        "rules:",
        "  - kind: unhandledProviderCase",
        '    boundary: "GET /orders"',
        '    provider: { summary: "cloudformation:template.yaml::GetOrders" }',
        "    reason: the queue is drained elsewhere",
      ].join("\n"),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      loadSuppressions(file);
    } finally {
      process.stderr.write = original;
    }

    expect(written.join("")).toContain("cloudformation:template.yaml");
    expect(written.join("")).toContain("write the path to pin it to one");
  });

  it("says nothing about a rule that already names the path", () => {
    const file = path.join(root, ".sussignore.yml");
    fs.writeFileSync(
      file,
      [
        "version: 1",
        "rules:",
        "  - kind: unhandledProviderCase",
        '    boundary: "GET /orders"',
        "    provider:",
        '      summary: "cloudformation:services/orders/template.yaml::GetOrders"',
        "    reason: the queue is drained elsewhere",
      ].join("\n"),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      loadSuppressions(file);
    } finally {
      process.stderr.write = original;
    }

    expect(written.join("")).toBe("");
  });
});

describe("naming a document by file name", () => {
  /** Load a one-rule file naming this document, and keep what it printed. */
  function loadNaming(document: string): {
    rules: SuppressionRule[];
    warning: string;
  } {
    const file = path.join(root, ".sussignore.yml");
    fs.writeFileSync(
      file,
      [
        "version: 1",
        "rules:",
        "  - kind: deadConsumerBranch",
        '    boundary: "GET /pet/:id"',
        `    provider: { summary: "${document}::GetOrders" }`,
        "    reason: the queue is drained elsewhere",
      ].join("\n"),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { rules: loadSuppressions(file), warning: written.join("") };
    } finally {
      process.stderr.write = original;
    }
  }

  /** A finding whose provider sits one directory down from `template.yaml`. */
  function findingAtPath(document: string): Finding {
    return {
      kind: "deadConsumerBranch",
      boundary: restBinding({
        transport: "http",
        recognition: "fetch",
        method: "GET",
        path: "/pet/:id",
      }),
      provider: {
        summary: `${document}::GetOrders`,
        location: {
          file: document,
          range: { start: 1, end: 1 },
          exportName: null,
        },
      },
      consumer: {
        summary: "src/ui/pet.ts::PetPage",
        transitionId: "ct-500",
        location: {
          file: "src/ui/pet.ts",
          range: { start: 1, end: 30 },
          exportName: "PetPage",
        },
      },
      description: "the consumer waits on a case the provider never produces",
      severity: "warning",
    };
  }

  // The loader warns about a rule that names a document by file name, and
  // the checker widens exactly those rules to every document of that
  // reader with that name. One shape decides both, so a rule that draws
  // the warning is a rule that still matches, and one that does not is
  // pinned to the path it names.
  it.each([
    {
      document: "cloudformation:template.yaml",
      deeper: "cloudformation:services/orders/template.yaml",
      byFileName: true,
    },
    {
      document: "openapi:spec.yaml",
      deeper: "openapi:apis/orders/spec.yaml",
      byFileName: true,
    },
    {
      document: "cloudformation:services/orders/template.yaml",
      deeper: "cloudformation:apps/services/orders/template.yaml",
      byFileName: false,
    },
    {
      document: "src/handlers/pet.ts",
      deeper: "src/api/handlers/pet.ts",
      byFileName: false,
    },
  ])("agrees on $document", ({ document, deeper, byFileName }) => {
    const { rules, warning } = loadNaming(document);
    const [checked] = applySuppressions([findingAtPath(deeper)], rules);

    expect(warning.includes("write the path to pin it to one")).toBe(
      byFileName,
    );
    expect(checked?.suppressed !== undefined).toBe(byFileName);
  });
});
