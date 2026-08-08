// What a document is called, and why two services' template.yaml have
// to be called two different things.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { documentSourceLabel } from "./documentLabel.js";

const made: string[] = [];

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-doc-label-"));
  made.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function write(root: string, relative: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "Resources: {}\n");
  return file;
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("documentSourceLabel", () => {
  it("tells two services' template.yaml apart by where each one sits", () => {
    const root = repository();
    const alpha = write(root, "services/alpha/template.yaml");
    const beta = write(root, "services/beta/template.yaml");

    expect(documentSourceLabel("cloudformation", alpha)).toBe(
      "cloudformation:services/alpha/template.yaml",
    );
    expect(documentSourceLabel("cloudformation", beta)).toBe(
      "cloudformation:services/beta/template.yaml",
    );
  });

  it("finds the repository through a linked worktree, whose .git is a file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-doc-label-"));
    made.push(root);
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
    const file = write(root, "infra/template.yaml");

    expect(documentSourceLabel("cloudformation", file)).toBe(
      "cloudformation:infra/template.yaml",
    );
  });

  it("keeps the URL a spec was fetched from, since the copy on disk is a temp file", () => {
    expect(
      documentSourceLabel(
        "cloudformation",
        "https://example.com/infra/template.yaml",
      ),
    ).toBe("cloudformation:https://example.com/infra/template.yaml");
  });

  it("answers from the nearest repository, so a vendored one speaks for its own files", () => {
    const outer = repository();
    const inner = path.join(outer, "vendor", "widgets");
    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(path.join(inner, ".git"));
    const file = write(outer, "vendor/widgets/infra/template.yaml");

    expect(documentSourceLabel("cloudformation", file)).toBe(
      "cloudformation:infra/template.yaml",
    );
  });

  it("falls back to the whole path for a file no repository holds", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "suss-doc-label-"));
    made.push(outside);
    const file = write(outside, "template.yaml");

    expect(documentSourceLabel("serverless", file)).toBe(`serverless:${file}`);
  });
});
