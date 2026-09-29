/**
 * Works out how a repository installs its JavaScript dependencies, from
 * the lockfiles it has checked in. Lifecycle scripts stay off: the
 * harness needs the packages on disk for type information, and never
 * runs a repository's own code.
 */

import fs from "node:fs";
import path from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "yarnBerry" | "npm";

export interface InstallStep {
  dir: string;
  manager: PackageManager;
  argv: string[];
  env: Record<string, string>;
}

export interface ToolPaths {
  bun: string;
  yarn: string;
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const SKIPPED_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "tmp",
  "examples",
  "fixtures",
  "test",
  "tests",
  "spec",
  "docs",
]);
const SEARCH_DEPTH = 4;

type CommandFor = (tools: ToolPaths) => Omit<InstallStep, "dir" | "manager">;

const INSTALL_COMMANDS: Record<PackageManager, CommandFor> = {
  bun: (tools) => ({
    argv: [tools.bun, "install", "--ignore-scripts"],
    env: {},
  }),
  pnpm: () => ({
    argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
    env: {},
  }),
  yarn: (tools) => ({
    argv: [tools.yarn, "install", "--frozen-lockfile", "--ignore-scripts"],
    env: {},
  }),
  yarnBerry: () => ({
    argv: ["corepack", "yarn", "install", "--immutable"],
    env: { YARN_ENABLE_SCRIPTS: "false", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  }),
  npm: () => ({ argv: ["npm", "ci", "--ignore-scripts"], env: {} }),
};

/**
 * A lockfile at the root covers the whole workspace, so nested ones are
 * only looked for when the root has none, as in a server repository
 * with its client in a subfolder.
 */
export function planInstall(root: string, tools: ToolPaths): InstallStep[] {
  const rootManager = managerFor(root);
  const dirs = rootManager === undefined ? lockfileDirs(root, 0) : [root];
  const steps: InstallStep[] = [];
  for (const dir of dirs) {
    const manager = managerFor(dir);
    if (manager === undefined) {
      continue;
    }

    steps.push({ dir, manager, ...INSTALL_COMMANDS[manager](tools) });
  }

  return steps;
}

export function managerFor(dir: string): PackageManager | undefined {
  const found = LOCKFILES.find(([file]) => fs.existsSync(path.join(dir, file)));
  if (found === undefined) {
    return undefined;
  }

  if (found[1] === "yarn" && usesYarnBerry(dir)) {
    return "yarnBerry";
  }

  return found[1];
}

function usesYarnBerry(dir: string): boolean {
  if (fs.existsSync(path.join(dir, ".yarnrc.yml"))) {
    return true;
  }

  const manifest = readManifest(dir);
  const declared =
    typeof manifest?.packageManager === "string" ? manifest.packageManager : "";
  return /^yarn@[2-9]/.test(declared);
}

function readManifest(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function lockfileDirs(dir: string, depth: number): string[] {
  const here = LOCKFILES.some(([file]) => fs.existsSync(path.join(dir, file)))
    ? [dir]
    : [];
  if (depth >= SEARCH_DEPTH) {
    return here;
  }

  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => lockfileDirs(path.join(dir, entry.name), depth + 1));
  return [...here, ...children];
}
