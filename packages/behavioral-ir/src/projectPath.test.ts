// What a document is called, and why two services' template.yaml have
// to be called two different things.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultProjectRoot,
  documentSourceLabel,
  pathInProject,
  projectNameOf,
} from "./projectPath.js";

const made: string[] = [];

function folder(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-doc-label-")),
  );
  made.push(root);
  return root;
}

function repository(): string {
  const root = folder();
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
    const root = folder();
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

  it("measures from the root it is given, whatever repository the file is in", () => {
    const root = repository();
    const file = write(root, "services/alpha/template.yaml");

    expect(
      documentSourceLabel("serverless", file, path.join(root, "services")),
    ).toBe("serverless:alpha/template.yaml");
  });

  it("measures from the working directory for a file no repository holds", () => {
    const outside = folder();
    const alpha = write(outside, "services/alpha/template.yaml");
    const beta = write(outside, "services/beta/template.yaml");
    const fromHere = (file: string) =>
      `serverless:${path.relative(process.cwd(), file).split(path.sep).join("/")}`;

    expect(documentSourceLabel("serverless", alpha)).toBe(fromHere(alpha));
    expect(documentSourceLabel("serverless", beta)).toBe(fromHere(beta));
    expect(documentSourceLabel("serverless", alpha)).not.toMatch(
      /^serverless:\//,
    );
  });
});

describe("pathInProject", () => {
  it("spells the same file the same way from two checkouts", () => {
    const one = folder();
    const two = path.join(folder(), "deeper", "checkout");

    expect(pathInProject(path.join(one, "src", "a.ts"), one)).toBe("src/a.ts");
    expect(pathInProject(path.join(two, "src", "a.ts"), two)).toBe("src/a.ts");
  });

  it("spells the root itself as a dot", () => {
    const root = folder();

    expect(pathInProject(root, root)).toBe(".");
  });

  it("climbs out of the root rather than writing an absolute path", () => {
    const root = folder();

    expect(pathInProject(path.join(root, "..", "shared", "a.ts"), root)).toBe(
      "../shared/a.ts",
    );
  });
});

describe("defaultProjectRoot", () => {
  it("is the repository a file is in", () => {
    const root = repository();
    const file = write(root, "infra/template.yaml");

    expect(defaultProjectRoot(file)).toBe(root);
  });

  it("is the working directory outside every repository", () => {
    const outside = folder();
    const file = write(outside, "infra/template.yaml");

    expect(defaultProjectRoot(file)).toBe(process.cwd());
  });
});

describe("projectNameOf", () => {
  it("is the name in the nearest package.json that has one", () => {
    const root = folder();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@acme/api" }),
    );
    fs.mkdirSync(path.join(root, "infra", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "infra", "dist", "package.json"),
      JSON.stringify({ type: "module" }),
    );

    expect(projectNameOf(path.join(root, "infra", "dist"))).toBe("@acme/api");
  });

  it("is the folder's own name when no package.json gives one", () => {
    const root = folder();

    expect(projectNameOf(root)).toBe(path.basename(root));
    expect(projectNameOf(path.parse(root).root)).toBeNull();
  });
});
