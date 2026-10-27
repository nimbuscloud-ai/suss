// A workspace whose root is a package with its own tsconfig, next to two
// packages with their own. `init --write` writes one suss.json at the
// root, and every later command reads it from there.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyOfFixture, readJson, readSummaries, runSuss } from "../harness.js";

interface ReadEntry {
  kind: string;
  dir?: string;
  project?: string;
  file?: string;
}

const SUMMARIES = [
  "client src/status.ts GET /status",
  "client src/orders.ts GET /orders/{id}",
  "handler src/server.ts GET /status",
  "handler src/server.ts GET /orders/:id",
].sort();

function summariesIn(file: string): string[] {
  return readSummaries(file)
    .map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      const boundary =
        semantics?.name === "rest"
          ? `${semantics.method} ${semantics.path}`
          : "";
      return `${summary.kind} ${summary.location.file} ${boundary}`;
    })
    .sort();
}

describe("set up a TypeScript monorepo", () => {
  const project = copyOfFixture("typescript-monorepo", "monorepo-setup");
  const init = runSuss(["init", "--write"], { cwd: project });
  const written = readJson(path.join(project, "suss.json")) as {
    read: ReadEntry[];
  };

  it("writes one read per package, each with its own folder and tsconfig", () => {
    expect(init.status, init.stderr).toBe(0);
    expect(
      written.read.map((entry) => [entry.dir ?? ".", entry.project]),
    ).toEqual([
      [".", "tsconfig.json"],
      ["packages/api", "packages/api/tsconfig.json"],
      ["packages/web", "packages/web/tsconfig.json"],
    ]);
  });

  it("writes every path from the folder suss.json is in", () => {
    const paths = written.read.flatMap((entry) =>
      [entry.dir, entry.project, entry.file].filter(
        (one): one is string => one !== undefined,
      ),
    );
    for (const one of paths) {
      expect(fs.existsSync(path.join(project, one)), one).toBe(true);
    }
  });

  it("reads every package on a bare extract", () => {
    const out = path.join(project, "all.json");
    const extract = runSuss(["extract", "-o", out], { cwd: project });

    expect(extract.status, extract.stderr).toBe(0);
    expect(extract.stderr).not.toContain("failed:");
    expect(summariesIn(out)).toEqual(SUMMARIES);
  });
});

describe("read a monorepo whose suss.json suss 0.34.0 wrote", () => {
  const project = copyOfFixture("typescript-monorepo", "monorepo-old-file");
  // 0.34.0 left out each folder and wrote each tsconfig path from inside it.
  fs.writeFileSync(
    path.join(project, "suss.json"),
    JSON.stringify({
      version: 1,
      read: [
        ["axios", "fetch", "node"],
        ["express", "fetch", "node"],
        ["fetch", "node"],
      ].map((packs) => ({
        kind: "extract",
        language: "typescript",
        project: "tsconfig.json",
        packs,
      })),
    }),
  );
  const out = path.join(project, "all.json");
  const extract = runSuss(["extract", "-o", out], { cwd: project });

  it("reads each package from its own folder", () => {
    expect(extract.status, extract.stderr).toBe(0);
    expect(extract.stderr).toContain(
      "--dir packages/api -p packages/api/tsconfig.json",
    );
    expect(summariesIn(out)).toEqual(SUMMARIES);
  });

  it("says how to write the folders into suss.json", () => {
    expect(extract.stderr).toContain("the way suss 0.34.0 wrote a monorepo");
    expect(extract.stderr).toContain("suss init --write --overwrite");
  });
});
