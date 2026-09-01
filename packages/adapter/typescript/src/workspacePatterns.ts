/**
 * Workspace-marked discovery patterns, rewritten to concrete ones.
 *
 * A pack can say `workspaces: true` on a `packageExports` or
 * `packageImport` match instead of listing packages, because the
 * packages belong to the project rather than to any library. The
 * adapter resolves that marker here, once, before anything else reads
 * the pack list, so prefiltering, health tallies, and dispatch all see
 * the same concrete patterns. The manifest is the first `package.json`
 * with `workspaces` (or `pnpm-workspace.yaml`) at or above the project
 * anchor; globs support literal segments and `*` within a segment, and
 * negation patterns are skipped. With no manifest in reach the marked
 * patterns are dropped and pack health reports the pack as silent.
 */

import fs from "node:fs";
import path from "node:path";

import { projectFileStamp } from "./version.js";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

interface WorkspacePackage {
  name: string;
  packageJsonPath: string;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function pnpmWorkspaceGlobs(yamlText: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yamlText.split("\n")) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s+-\s+["']?([^"'#\s]+)["']?/);
      if (item !== null) {
        globs.push(item[1]);
        continue;
      }
      if (/^\S/.test(line)) {
        inPackages = false;
      }
    }
  }
  return globs;
}

function workspaceGlobsAt(dir: string): string[] | null {
  const pkg = readJson(path.join(dir, "package.json"));
  if (typeof pkg === "object" && pkg !== null && "workspaces" in pkg) {
    const ws = (pkg as { workspaces: unknown }).workspaces;
    if (Array.isArray(ws)) {
      return ws.filter((g): g is string => typeof g === "string");
    }
    if (
      typeof ws === "object" &&
      ws !== null &&
      Array.isArray((ws as { packages?: unknown }).packages)
    ) {
      return (ws as { packages: unknown[] }).packages.filter(
        (g): g is string => typeof g === "string",
      );
    }
  }

  const pnpmPath = path.join(dir, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmPath)) {
    try {
      return pnpmWorkspaceGlobs(fs.readFileSync(pnpmPath, "utf8"));
    } catch {
      return null;
    }
  }

  return null;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function subdirectoriesOf(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules");
  } catch {
    return [];
  }
}

function segmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`);
}

function directoriesMatchingGlob(root: string, glob: string): string[] {
  let current = [root];
  for (const segment of glob.split("/").filter((s) => s.length > 0)) {
    const next: string[] = [];
    if (segment.includes("*")) {
      const pattern = segmentToRegExp(segment);
      for (const dir of current) {
        for (const entry of subdirectoriesOf(dir)) {
          if (pattern.test(entry)) {
            next.push(path.join(dir, entry));
          }
        }
      }
    } else {
      for (const dir of current) {
        next.push(path.join(dir, segment));
      }
    }
    current = next.filter(isDirectory);
  }
  return current;
}

function packageAt(dir: string): WorkspacePackage | null {
  const packageJsonPath = path.join(dir, "package.json");
  const pkg = readJson(packageJsonPath);
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    typeof (pkg as { name?: unknown }).name === "string"
  ) {
    return { name: (pkg as { name: string }).name, packageJsonPath };
  }
  return null;
}

function workspacePackagesFrom(anchor: string): WorkspacePackage[] {
  let dir = path.resolve(anchor);
  for (;;) {
    const globs = workspaceGlobsAt(dir);
    if (globs !== null) {
      const found = new Map<string, WorkspacePackage>();
      for (const glob of globs) {
        if (glob.startsWith("!")) {
          continue;
        }
        for (const match of directoriesMatchingGlob(dir, glob)) {
          const pkg = packageAt(match);
          if (pkg !== null) {
            found.set(pkg.packageJsonPath, pkg);
          }
        }
      }
      return [...found.values()].sort((a, b) =>
        a.packageJsonPath.localeCompare(b.packageJsonPath),
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return [];
    }
    dir = parent;
  }
}

function isWorkspaceMarked(pattern: DiscoveryPattern): boolean {
  const match = pattern.match;
  return (
    (match.type === "packageExports" || match.type === "packageImport") &&
    match.workspaces === true
  );
}

function expandPattern(
  pattern: DiscoveryPattern,
  packages: WorkspacePackage[],
): DiscoveryPattern[] {
  const match = pattern.match;
  if (match.type === "packageExports" && match.workspaces === true) {
    const { workspaces: _workspaces, ...rest } = match;
    return packages.map((pkg) => ({
      ...pattern,
      match: { ...rest, packageJsonPath: pkg.packageJsonPath },
    }));
  }

  if (match.type === "packageImport" && match.workspaces === true) {
    const listed = match.packages ?? [];
    const names = [...new Set([...listed, ...packages.map((p) => p.name)])];
    if (names.length === 0) {
      return [];
    }
    return [{ ...pattern, match: { type: "packageImport", packages: names } }];
  }

  return [pattern];
}

/**
 * Feeds the pack digest, so a cached run notices when workspace
 * membership changed even though no pack and no source file did. The
 * content of each manifest counts too: an `exports` map says which
 * files are on the package's boundary, and editing one changes what
 * this pack discovers without touching a line of TypeScript.
 */
export function workspaceExpansionStamp(
  frameworks: ReadonlyArray<PatternPack>,
): string {
  const paths = frameworks
    .flatMap((pack) => pack.discovery)
    .flatMap((pattern) =>
      pattern.match.type === "packageExports" &&
      pattern.match.packageJsonPath !== undefined
        ? [pattern.match.packageJsonPath]
        : [],
    );
  return projectFileStamp(paths);
}

export function expandWorkspacePatterns(
  frameworks: PatternPack[],
  anchor: string | undefined,
): PatternPack[] {
  const marked = frameworks.some((pack) =>
    pack.discovery.some(isWorkspaceMarked),
  );
  if (!marked) {
    return frameworks;
  }

  const packages = anchor !== undefined ? workspacePackagesFrom(anchor) : [];
  return frameworks.map((pack) => ({
    ...pack,
    discovery: pack.discovery.flatMap((pattern) =>
      expandPattern(pattern, packages),
    ),
  }));
}
