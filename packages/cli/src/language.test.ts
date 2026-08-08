import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectLanguages,
  languageOfProject,
  parseLanguage,
  projectFilesOf,
} from "./language.js";

describe("detectLanguages", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-language-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents = ""): void {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it("recognizes a Python project by any of the files that name one", () => {
    for (const marker of [
      "pyproject.toml",
      "requirements.txt",
      "setup.py",
      "Pipfile",
    ]) {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-"));
      fs.writeFileSync(path.join(project, marker), "");
      expect(detectLanguages(project), marker).toEqual(["python"]);
    }
  });

  it("recognizes a Ruby project by its Gemfile", () => {
    write("Gemfile", "source 'https://rubygems.org'\n");
    expect(detectLanguages(dir)).toEqual(["ruby"]);
  });

  it("recognizes a Rails app by config/application.rb", () => {
    // graphql-ruby's root is under app/, so a Rails app with its gems
    // vendored and no lock file in reach still has to be recognized.
    write("config/application.rb", "module MyApp\nend\n");
    expect(detectLanguages(dir)).toEqual(["ruby"]);
  });

  it("recognizes a language by its source files when nothing names a project", () => {
    write("src/app.py", "x = 1\n");
    expect(detectLanguages(dir)).toEqual(["python"]);
  });

  it("names both languages of a project written in two", () => {
    write("package.json", "{}");
    write("service/main.py", "x = 1\n");
    expect(detectLanguages(dir)).toEqual(["typescript", "python"]);
  });

  it("says which marker files a project actually has", () => {
    write("requirements.txt", "");
    expect(projectFilesOf(dir, "python")).toEqual(["requirements.txt"]);
    expect(projectFilesOf(dir, "ruby")).toEqual([]);
  });
});

describe("languageOfProject", () => {
  it("reads a directory of Python as Python", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-"));
    fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\n");
    expect(languageOfProject(dir)).toEqual({ language: "python" });
  });

  it("keeps reading a mixed project as TypeScript, the way every run before did", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-mixed-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "script.py"), "x = 1\n");
    expect(languageOfProject(dir)).toEqual({ language: "typescript" });
  });

  it("says it cannot tell, and how to say so, for an empty directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-empty-"));
    const answer = languageOfProject(dir);
    expect("cannotTell" in answer && answer.cannotTell).toContain("--lang");
  });
});

describe("parseLanguage", () => {
  it("takes the three names the flag accepts", () => {
    expect(parseLanguage("python")).toBe("python");
    expect(parseLanguage("ruby")).toBe("ruby");
    expect(parseLanguage("typescript")).toBe("typescript");
  });

  it("answers null for anything else, so the caller can say what it takes", () => {
    expect(parseLanguage("perl")).toBeNull();
  });
});
