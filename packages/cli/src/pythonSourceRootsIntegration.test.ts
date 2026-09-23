/**
 * `suss extract` from the directory above a Python package kept under
 * a source directory. The adapter reads which directories those are;
 * the CLI prints what it could not read.
 *
 * The cache test runs the built binary, because the cache turns itself
 * off when the adapter is loaded from source.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatUnreadManifests } from "./extract.js";

const FIXTURES = path.resolve(
  __dirname,
  "../../../fixtures/python-source-roots",
);
const BIN = path.resolve(__dirname, "../dist/bin.js");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-source-roots-cli-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function extractPaths(project: string): { paths: unknown[]; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [BIN, "extract", "-f", "fastapi", "-o", "out.json"],
    { cwd: project, encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) {
    throw new Error(`extract failed: ${result.stderr}`);
  }
  const summaries = JSON.parse(
    fs.readFileSync(path.join(project, "out.json"), "utf8"),
  ) as Array<{ identity: { boundaryBinding?: { semantics: unknown } } }>;
  return {
    paths: summaries.map(
      (s) =>
        (s.identity.boundaryBinding?.semantics as { path?: unknown })?.path,
    ),
    stderr: result.stderr,
  };
}

describe("extract over a project whose package is below the directory it runs in", () => {
  it("mounts the route once pyproject.toml declares the source directory, past a cached run from before", () => {
    const project = path.join(dir, "moved");
    fs.cpSync(path.join(FIXTURES, "setuptools-package-dir"), project, {
      recursive: true,
    });
    const pyproject = path.join(project, "pyproject.toml");
    const declared = fs.readFileSync(pyproject, "utf8");
    fs.writeFileSync(pyproject, '[project]\nname = "orders"\n');

    expect(extractPaths(project).paths).toEqual([null]);
    fs.writeFileSync(pyproject, declared);
    expect(extractPaths(project).paths).toEqual(["/orders/{order_id}"]);
  }, 300_000);

  it("says which manifest it could not read and where imports resolve", () => {
    const project = path.join(FIXTURES, "unreadable-toml");
    const text = formatUnreadManifests(
      [
        {
          where: "pyproject.toml",
          reason: "it is not valid TOML: oops (line 9)",
        },
      ],
      project,
      [project, path.join(project, "src")],
    );
    expect(text).toBe(
      "[suss] Could not read pyproject.toml to find where the Python sources are, because it is not valid TOML: oops (line 9).\n[suss] Absolute imports resolve against ., src.\n",
    );
  });

  it("prints nothing when every manifest was read", () => {
    expect(formatUnreadManifests([], dir, [dir])).toBe("");
  });
});
