import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatInitReport, inspectProject } from "./init.js";

const roots: string[] = [];

function makeRepo(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-init-"));
  roots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("what a service reaches", () => {
  it("finds a library its own package brings in", () => {
    // The service depends on a package of its own, and that package is
    // what depends on the SDK.
    const root = makeRepo({
      "package.json": { name: "svc", dependencies: { "@acme/messaging": "*" } },
      "packages/messaging/package.json": {
        name: "@acme/messaging",
        dependencies: { "@aws-sdk/client-sqs": "*" },
      },
    });
    fs.mkdirSync(path.join(root, "node_modules/@acme"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "packages/messaging"),
      path.join(root, "node_modules/@acme/messaging"),
    );

    const names = inspectProject(root).suggestions.map((s) => s.name);
    expect(names).toContain("aws-sqs");
  });

  it("stops at a published library", () => {
    // Something we depend on depending on express does not make this an
    // express service.
    const root = makeRepo({
      "package.json": { name: "svc", dependencies: { "some-lib": "*" } },
      "node_modules/some-lib/package.json": {
        name: "some-lib",
        dependencies: { express: "*" },
      },
    });

    expect(inspectProject(root).suggestions.map((s) => s.name)).not.toContain(
      "express",
    );
  });
});

describe("a pack that only reads calls", () => {
  it("rides along with the pack that finds the units", () => {
    const root = makeRepo({
      "package.json": {
        name: "svc",
        dependencies: { express: "*", "drizzle-orm": "*" },
      },
    });

    const printed = formatInitReport(inspectProject(root));
    expect(printed).toMatch(/suss extract .*-f express.*-f drizzle/);
  });

  it("says so rather than printing a command that comes back empty", () => {
    const root = makeRepo({
      "package.json": { name: "svc", dependencies: { "drizzle-orm": "*" } },
    });

    const printed = formatInitReport(inspectProject(root));
    expect(printed).toContain("comes");
    expect(printed).toContain("back empty");
    expect(printed).not.toMatch(/^ {3}suss extract -f drizzle -o/m);
  });
});
