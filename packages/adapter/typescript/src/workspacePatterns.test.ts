import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  expandWorkspacePatterns,
  workspaceExpansionStamp,
} from "./workspacePatterns.js";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

const created: string[] = [];

function tempWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ws-"));
  created.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function packWith(...discovery: DiscoveryPattern[]): PatternPack {
  return {
    name: "test",
    languages: ["typescript"],
    protocol: "in-process",
    discovery,
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
  };
}

const workspaceMarked: DiscoveryPattern[] = [
  { kind: "library", match: { type: "packageExports", workspaces: true } },
  { kind: "caller", match: { type: "packageImport", workspaces: true } },
];

function pkgJson(name: string): string {
  return JSON.stringify({ name, main: "src/index.ts" });
}

describe("expandWorkspacePatterns", () => {
  it("returns the pack list untouched when nothing is workspace-marked", () => {
    const packs = [
      packWith({
        kind: "library",
        match: { type: "packageExports", packageJsonPath: "/x/package.json" },
      }),
    ];
    expect(expandWorkspacePatterns(packs, "/tmp")).toBe(packs);
  });

  it("rewrites the markers into one packageExports per package and one packages list", () => {
    const root = tempWorkspace({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
      }),
      "packages/a/package.json": pkgJson("@demo/a"),
      "packages/b/package.json": pkgJson("@demo/b"),
    });

    const [pack] = expandWorkspacePatterns(
      [packWith(...workspaceMarked)],
      root,
    );
    const exportMatches = pack.discovery.filter(
      (d) => d.match.type === "packageExports",
    );
    expect(
      exportMatches.map((d) =>
        d.match.type === "packageExports" ? d.match.packageJsonPath : undefined,
      ),
    ).toEqual([
      path.join(root, "packages/a/package.json"),
      path.join(root, "packages/b/package.json"),
    ]);

    const importMatch = pack.discovery.find(
      (d) => d.match.type === "packageImport",
    );
    expect(
      importMatch?.match.type === "packageImport"
        ? importMatch.match.packages
        : undefined,
    ).toEqual(["@demo/a", "@demo/b"]);
  });

  it("finds the manifest above the anchor and honors two-level globs", () => {
    const root = tempWorkspace({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: { packages: ["packages/*/*"] },
      }),
      "packages/group/a/package.json": pkgJson("@demo/deep"),
      "apps/tsconfig.json": "{}",
    });

    const [pack] = expandWorkspacePatterns(
      [packWith(...workspaceMarked)],
      path.join(root, "apps"),
    );
    const importMatch = pack.discovery.find(
      (d) => d.match.type === "packageImport",
    );
    expect(
      importMatch?.match.type === "packageImport"
        ? importMatch.match.packages
        : undefined,
    ).toEqual(["@demo/deep"]);
  });

  it("reads pnpm-workspace.yaml when package.json has no workspaces field", () => {
    const root = tempWorkspace({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": 'packages:\n  - "libs/*"\n',
      "libs/a/package.json": pkgJson("@demo/pnpm"),
    });

    const [pack] = expandWorkspacePatterns(
      [packWith(...workspaceMarked)],
      root,
    );
    const importMatch = pack.discovery.find(
      (d) => d.match.type === "packageImport",
    );
    expect(
      importMatch?.match.type === "packageImport"
        ? importMatch.match.packages
        : undefined,
    ).toEqual(["@demo/pnpm"]);
  });

  it("drops marked patterns when no manifest is in reach", () => {
    const root = tempWorkspace({ "src/a.ts": "" });
    const [pack] = expandWorkspacePatterns(
      [packWith(...workspaceMarked)],
      path.join(root, "src"),
    );
    expect(pack.discovery).toEqual([]);
  });

  it("skips directories without a named package.json and negation globs", () => {
    const root = tempWorkspace({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*", "!packages/b"],
      }),
      "packages/a/package.json": pkgJson("@demo/a"),
      "packages/empty/README.md": "",
    });

    const [pack] = expandWorkspacePatterns(
      [packWith(...workspaceMarked)],
      root,
    );
    const importMatch = pack.discovery.find(
      (d) => d.match.type === "packageImport",
    );
    expect(
      importMatch?.match.type === "packageImport"
        ? importMatch.match.packages
        : undefined,
    ).toEqual(["@demo/a"]);
  });
});

describe("workspaceExpansionStamp", () => {
  it("changes when the concrete package set changes", () => {
    const concrete = (p: string): PatternPack =>
      packWith({
        kind: "library",
        match: { type: "packageExports", packageJsonPath: p },
      });
    const one = workspaceExpansionStamp([concrete("/a/package.json")]);
    const two = workspaceExpansionStamp([concrete("/b/package.json")]);
    expect(one).not.toEqual(two);
    expect(workspaceExpansionStamp([packWith(...workspaceMarked)])).toBe(
      "none",
    );
  });
});
