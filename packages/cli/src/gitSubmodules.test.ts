import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkedOutSubmodules,
  formatMissingSubmodules,
  readSubmodules,
} from "./gitSubmodules.js";

describe("readSubmodules", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "suss-sub-")));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeGitmodules(...paths: string[]): void {
    fs.writeFileSync(
      path.join(dir, ".gitmodules"),
      paths
        .map(
          (p) =>
            `[submodule "${p}"]\n\tpath = ${p}\n\turl = https://example.invalid/${p}.git\n`,
        )
        .join(""),
    );
  }

  it("names each submodule the repository declares", () => {
    writeGitmodules("libs/shared", "libs/framework");
    fs.mkdirSync(path.join(dir, "libs", "shared"), { recursive: true });
    fs.writeFileSync(path.join(dir, "libs", "shared", "thing.py"), "x = 1\n");
    fs.mkdirSync(path.join(dir, "libs", "framework"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "libs", "framework", "api.py"),
      "def route(): ...\n",
    );

    expect(readSubmodules(dir).map((s) => s.declaredPath)).toEqual([
      "libs/shared",
      "libs/framework",
    ]);
    expect(checkedOutSubmodules(dir)).toEqual([
      path.join(dir, "libs", "shared"),
      path.join(dir, "libs", "framework"),
    ]);
  });

  it("finds the declaration from a service inside the repository", () => {
    // The directory suss is pointed at is usually a service, and
    // .gitmodules sits at the repository root above it.
    writeGitmodules("libs/framework");
    fs.mkdirSync(path.join(dir, "services", "orders"), { recursive: true });
    fs.mkdirSync(path.join(dir, "libs", "framework"), { recursive: true });
    fs.writeFileSync(path.join(dir, "libs", "framework", "api.py"), "");

    expect(
      readSubmodules(path.join(dir, "services", "orders")).map(
        (s) => s.declaredPath,
      ),
    ).toEqual(["libs/framework"]);
  });

  it("marks a submodule nobody checked out, and says what to run", () => {
    writeGitmodules("libs/framework");
    fs.mkdirSync(path.join(dir, "libs", "framework"), { recursive: true });

    const submodules = readSubmodules(dir);
    expect(submodules[0]?.checkedOut).toBe(false);
    expect(checkedOutSubmodules(dir)).toEqual([]);

    const message = formatMissingSubmodules(submodules);
    expect(message).toContain("libs/framework");
    expect(message).toContain("git submodule update --init");
  });

  it("says nothing when every submodule is checked out", () => {
    writeGitmodules("libs/framework");
    fs.mkdirSync(path.join(dir, "libs", "framework"), { recursive: true });
    fs.writeFileSync(path.join(dir, "libs", "framework", "api.py"), "");
    expect(formatMissingSubmodules(readSubmodules(dir))).toBe("");
  });

  it("has nothing to say about a repository with no submodules", () => {
    expect(readSubmodules(dir)).toEqual([]);
  });
});
