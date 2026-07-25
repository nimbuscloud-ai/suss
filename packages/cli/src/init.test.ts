import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatInitReport, inspectProject } from "./init.js";

describe("inspectProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-init-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(manifest: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  function names(root: string): string[] {
    return inspectProject(root)
      .suggestions.map((s) => s.name)
      .sort();
  }

  it("picks a framework pack out of dependencies", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    expect(names(dir)).toEqual(["hono"]);
  });

  it("reads devDependencies too, which is where the Lambda types live", () => {
    writeManifest({ devDependencies: { "@types/aws-lambda": "^8.10.0" } });
    expect(names(dir)).toEqual(["aws-lambda"]);
  });

  it("picks a client pack as well as a framework", () => {
    writeManifest({
      dependencies: { express: "^4.0.0", axios: "^1.0.0" },
    });
    expect(names(dir)).toEqual(["axios", "express"]);
  });

  it("finds a contract source on disk", () => {
    writeManifest({ dependencies: {} });
    fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}\n");
    const report = inspectProject(dir);
    expect(report.suggestions.map((s) => s.name)).toEqual(["cloudformation"]);
    expect(report.suggestions[0]?.file).toBe("template.yaml");
  });

  it("names one pack once, however many things point at it", () => {
    writeManifest({
      dependencies: { "react-router": "^7.0.0", "react-router-dom": "^7.0.0" },
    });
    expect(names(dir)).toEqual(["react-router"]);
  });

  it("ignores node_modules, which would otherwise match everything", () => {
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "node_modules", "some-package");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "schema.prisma"), "");
    expect(names(dir)).toEqual([]);
  });

  it("notices whether the project has a tsconfig", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    expect(inspectProject(dir).tsconfig).toBeNull();
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    expect(inspectProject(dir).tsconfig).not.toBeNull();
  });

  it("survives a package.json that will not parse", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(() => inspectProject(dir)).not.toThrow();
  });
});

describe("formatInitReport", () => {
  it("prints one extract command covering every pack", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: "/project/tsconfig.json",
      suggestions: [
        {
          name: "hono",
          packageName: "@suss/framework-hono",
          because: "hono in dependencies",
          kind: "framework",
        },
        {
          name: "axios",
          packageName: "@suss/client-axios",
          because: "axios in dependencies",
          kind: "client",
        },
      ],
    });

    // One pass over the project reads every pack, so one command does.
    expect(output).toContain("suss extract -f hono -f axios");
    expect(output).toContain("@suss/framework-hono @suss/client-axios");
  });

  it("puts the file it found into the contract command", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: null,
      suggestions: [
        {
          name: "cloudformation",
          packageName: "@suss/contract-cloudformation",
          because: "a SAM template at template.yaml",
          kind: "contract",
          file: "template.yaml",
        },
      ],
    });

    expect(output).toContain(
      "suss contract --from cloudformation template.yaml",
    );
  });

  it("says so plainly when nothing matched", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: null,
      suggestions: [],
    });

    expect(output).toContain("Nothing in /project matched a pack");
    expect(output).toContain("suss --help");
  });
});
