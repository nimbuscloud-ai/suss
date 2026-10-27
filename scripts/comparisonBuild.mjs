/**
 * comparisonBuild.mjs: a second build of suss at another commit, for the
 * scripts that run two builds side by side (benchmark.mjs, byteCheck.mjs).
 *
 * The build lives in a worktree of its own under the temp directory and
 * is kept for the next comparison. `npm run build` builds every package
 * in dependency order: a pack, then @suss/packs that bundles it, then the
 * CLI. `git worktree list` shows the builds and `git worktree remove`
 * takes one back out.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "./workspacePackages.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function git(args, cwd = ROOT) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}

/** The CLI entry point of the checkout at `dir`. */
export function binFor(dir) {
  return path.join(dir, "packages", "cli", "dist", "bin.js");
}

export function describeBuild(dir, label) {
  const sha = git(["rev-parse", "--short", "HEAD"], dir);
  const dirty = git(["status", "--porcelain"], dir) !== "";
  return { label, dir, sha, dirty };
}

/** The build in this checkout, which has to have been built already. */
export function thisBuild() {
  if (!fs.existsSync(binFor(ROOT))) {
    fail("This checkout has no built CLI. Run `npm run build` first.");
  }
  return describeBuild(ROOT, "this build");
}

/** Builds `ref` in a worktree of its own, or reuses an earlier build. */
export function buildAt(ref) {
  const sha = git(["rev-parse", "--short", ref]);
  const dir = path.join(os.tmpdir(), "suss-benchmark-builds", sha);
  if (!fs.existsSync(binFor(dir))) {
    if (!fs.existsSync(dir)) {
      process.stderr.write(
        `Preparing a build at ${sha}. This takes a few minutes.\n`,
      );
      git(["worktree", "add", "--detach", dir, sha]);
    }
    runOrFail(dir, "npm", ["install", "--no-audit", "--no-fund"]);
    // The task cache is keyed by what a task reads, not by the tree that
    // ran it, so a shared cache could restore this build's artifacts into
    // the author's tree. This build caches inside its own worktree.
    runOrFail(dir, "npm", ["run", "build"], {
      TURBO_CACHE_DIR: path.join(dir, ".turbo", "benchmark-cache"),
    });
  }
  return describeBuild(dir, sha);
}

function runOrFail(cwd, command, args, env = {}) {
  const res = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    fail(`${command} ${args.join(" ")} failed in ${cwd}.`);
  }
}

/**
 * Gives every build the heap and young generation this checkout's CLI
 * picks, so the CLI never starts itself again and the measured process
 * is the one doing the work.
 */
export async function heapFlags() {
  const heap = await import(
    pathToFileURL(path.join(ROOT, "packages", "cli", "dist", "heapSize.js"))
      .href
  );
  const size = heap.heapSizeFor(heap.availableMemoryMb());
  const young = heap.youngGenerationFlag(size);
  // A size set in NODE_OPTIONS reaches every build and wins.
  if (heap.heapSizeWasChosen(process.env.NODE_OPTIONS, [])) {
    return [young];
  }
  return [`--max-old-space-size=${size}`, young];
}
