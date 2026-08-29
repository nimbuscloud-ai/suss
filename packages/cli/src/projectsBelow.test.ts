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
  it("finds one marker per project, and says where each is", () => {
    const root = projectTree({
      "service/tsconfig.json": "{}",
      "job/tsconfig.json": "{}",
      "service/src/index.ts": "export const a = 1;",
    });

    expect(projectsBelow(root, "typescript")).toEqual([
      "job/tsconfig.json",
      "service/tsconfig.json",
    ]);
  });

  it("takes a jsconfig as a project too", () => {
    const root = projectTree({ "web/jsconfig.json": "{}" });
    expect(projectsBelow(root, "typescript")).toEqual(["web/jsconfig.json"]);
  });

  it("reads the markers of the language it was asked about", () => {
    const root = projectTree({
      "svc/pyproject.toml": "[project]\nname = 'svc'\n",
      "web/tsconfig.json": "{}",
    });

    expect(projectsBelow(root, "python")).toEqual(["svc/pyproject.toml"]);
    expect(projectsBelow(root, "typescript")).toEqual(["web/tsconfig.json"]);
  });

  it("takes any of the ways a Python project says so", () => {
    const root = projectTree({
      "a/requirements.txt": "fastapi\n",
      "b/setup.py": "from setuptools import setup\n",
    });

    expect(projectsBelow(root, "python")).toEqual([
      "a/requirements.txt",
      "b/setup.py",
    ]);
  });

  it("takes a Gemfile as a Ruby project", () => {
    const root = projectTree({ "api/Gemfile": "source 'x'\n" });
    expect(projectsBelow(root, "ruby")).toEqual(["api/Gemfile"]);
  });

  it("stops at a project rather than listing the ones nested in it", () => {
    const root = projectTree({
      "service/tsconfig.json": "{}",
      "service/nested/tsconfig.json": "{}",
    });

    expect(projectsBelow(root, "typescript")).toEqual([
      "service/tsconfig.json",
    ]);
  });

  it("leaves installed and built directories alone", () => {
    const root = projectTree({
      "node_modules/pkg/tsconfig.json": "{}",
      "dist/tsconfig.json": "{}",
      ".venv/lib/pyproject.toml": "[project]\n",
    });

    expect(projectsBelow(root, "typescript")).toEqual([]);
    expect(projectsBelow(root, "python")).toEqual([]);
  });

  it("says nothing when the directory holds no project", () => {
    expect(formatProjectsBelow([], "typescript")).toBe("");
    expect(formatProjectsBelow([], "python")).toBe("");
  });

  it("names the projects and the command that reads one", () => {
    const said = formatProjectsBelow(
      ["job/tsconfig.json", "svc/tsconfig.json"],
      "typescript",
    );

    expect(said).toContain("job/tsconfig.json, svc/tsconfig.json");
    expect(said).toContain("suss extract -p job/tsconfig.json");
  });

  it("points a Python reader at the directory rather than a tsconfig", () => {
    const said = formatProjectsBelow(["svc_a/pyproject.toml"], "python");

    expect(said).toContain("suss extract --dir svc_a");
    expect(said).not.toContain("-p ");
  });

  it("counts the rest rather than listing every one", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map(
      (n) => `${n}/tsconfig.json`,
    );
    expect(formatProjectsBelow(many, "typescript")).toContain("and 2 more");
  });
});
