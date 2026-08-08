import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findSuppressionsFile,
  loadSuppressions,
  suppressionsSearchDirs,
} from "./suppressionsLoader.js";

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
