import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatProjectsBelow, projectsBelow } from "./projectsBelow.js";

function projectTree(layout: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-projects-"));
  for (const [file, contents] of Object.entries(layout)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

describe("the projects under a directory", () => {
  it("finds one config per project, and says where each is", () => {
    const root = projectTree({
      "service/tsconfig.json": "{}",
      "job/tsconfig.json": "{}",
      "service/src/index.ts": "export const a = 1;",
    });

    expect(projectsBelow(root)).toEqual([
      "job/tsconfig.json",
      "service/tsconfig.json",
    ]);
  });

  it("takes a jsconfig as a project too", () => {
    const root = projectTree({ "web/jsconfig.json": "{}" });
    expect(projectsBelow(root)).toEqual(["web/jsconfig.json"]);
  });

  it("stops at a project rather than listing the ones nested in it", () => {
    const root = projectTree({
      "service/tsconfig.json": "{}",
      "service/nested/tsconfig.json": "{}",
    });

    expect(projectsBelow(root)).toEqual(["service/tsconfig.json"]);
  });

  it("leaves installed and built directories alone", () => {
    const root = projectTree({
      "node_modules/pkg/tsconfig.json": "{}",
      "dist/tsconfig.json": "{}",
    });

    expect(projectsBelow(root)).toEqual([]);
  });

  it("says nothing when the directory holds no project", () => {
    expect(formatProjectsBelow([])).toBe("");
  });

  it("names the projects and the command that reads one", () => {
    const said = formatProjectsBelow([
      "job/tsconfig.json",
      "svc/tsconfig.json",
    ]);

    expect(said).toContain("job/tsconfig.json, svc/tsconfig.json");
    expect(said).toContain("suss extract -p job/tsconfig.json");
  });

  it("counts the rest rather than listing every one", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map(
      (n) => `${n}/tsconfig.json`,
    );
    expect(formatProjectsBelow(many)).toContain("and 2 more");
  });
});
