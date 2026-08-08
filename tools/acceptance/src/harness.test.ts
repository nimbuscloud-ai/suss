import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyOfFixture,
  filesUnder,
  fixture,
  runSuss,
  SUSS_BIN,
  workspace,
} from "./harness.js";

describe("the harness", () => {
  it("runs the binary a person installs, not a source file", () => {
    expect(
      SUSS_BIN.endsWith(path.join("packages", "cli", "dist", "bin.js")),
    ).toBe(true);
    expect(fs.existsSync(SUSS_BIN)).toBe(true);
    expect(fs.readFileSync(SUSS_BIN, "utf8").split("\n", 1)[0]).toBe(
      "#!/usr/bin/env node",
    );
  });

  it("hands back the exit code, both streams, and no exception", () => {
    const help = runSuss(["--help"]);

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("suss extract");
    expect(help.stderr).toBe("");
    expect(help.output).toBe(help.stdout);
  });

  it("gives a journey an empty directory of its own", () => {
    const first = workspace("harness");
    const second = workspace("harness");

    expect(first).not.toBe(second);
    expect(filesUnder(first)).toEqual([]);
  });

  it("copies a fixture so a journey can write beside the code", () => {
    const project = copyOfFixture("ruby-graphql", "harness-copy");

    expect(filesUnder(project)).toContain(
      path.join("app", "graphql", "types", "query_type.rb"),
    );

    fs.writeFileSync(path.join(project, "scratch.txt"), "");
    expect(filesUnder(fixture("ruby-graphql"))).not.toContain("scratch.txt");
  });
});
