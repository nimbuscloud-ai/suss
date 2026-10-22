/**
 * `suss check --base <ref>`: read the revision a branch started from, so
 * a check can report the findings the branch introduced.
 *
 * The base is the commit HEAD shares with the ref, the one `git diff
 * ref...HEAD` compares against, so commits that landed on the ref after
 * the branch left it are not counted as part of the branch. `git archive`
 * writes that commit into a temporary folder, which leaves the checkout,
 * its index and its worktree list alone. The folder is read with the
 * reads the working tree declares, so both sides use the same packs.
 * The changed files are what git lists against the base, uncommitted and
 * untracked files included, since an agent asks before it commits.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireFolderLock, releaseFolderLock } from "./folderLock.js";
import {
  commandFor,
  declaredReads,
  packSpecsOf,
  readProjectInto,
} from "./projectRead.js";
import { UsageError } from "./usageError.js";

import type { DeclaredReads, ReadEntry } from "./projectRead.js";

/** The revision a check compared with, as the user named it and as git resolved it. */
export interface BaseRevision {
  ref: string;
  commit: string;
  /**
   * False when git could not find where HEAD left the ref, as in a
   * shallow clone, and the ref's own commit was used instead.
   */
  branchPoint: boolean;
}

export interface BaseRead extends BaseRevision {
  /** A folder of summaries read from the base, one file per read. */
  summaryDir: string;
  /** Paths changed since the base, relative to the project root. */
  changedFiles: string[];
}

/**
 * Base folders already read, by commit, project and reads, so a server
 * asked twice about one branch reads the base once. The two most recent
 * are kept, and every one is removed when the process exits.
 */
const readFolders = new Map<string, string>();
const FOLDERS_KEPT = 2;

/**
 * Reads the base revision of the project at `root`. The changed files
 * are listed again on every call, since the working tree moves between
 * two questions and the base does not.
 */
export async function readBase(root: string, ref: string): Promise<BaseRead> {
  const project = fs.realpathSync(path.resolve(root));
  const top = gitTop(project);
  const revision = resolveBase(project, ref);
  const reads = await declaredReads(project);
  if (reads.reads.length === 0) {
    throw new UsageError(
      `Nothing in ${project} matched a pack, so there is nothing to read at ${ref}. Run \`suss init\` to see what suss looked for.`,
    );
  }

  const summaryDir = await baseFolder(top, project, revision, reads);
  return {
    ...revision,
    summaryDir,
    changedFiles: changedFiles(project, revision.commit),
  };
}

async function baseFolder(
  top: string,
  project: string,
  revision: BaseRevision,
  reads: DeclaredReads,
): Promise<string> {
  const key = JSON.stringify([revision.commit, project, reads.reads]);
  const running = readsInFlight.get(key);
  if (running !== undefined) {
    return await running;
  }

  const known = readFolders.get(key);
  if (known !== undefined && fs.existsSync(summariesIn(known))) {
    return summariesIn(known);
  }

  if (known !== undefined) {
    fs.rmSync(known, { recursive: true, force: true });
  }
  const work = temporaryFolder();
  readFolders.set(key, work);
  for (const [stale, folder] of [...readFolders].slice(0, -FOLDERS_KEPT)) {
    readFolders.delete(stale);
    fs.rmSync(folder, { recursive: true, force: true });
  }

  const read = readUnderLock(top, project, revision, reads, work);
  readsInFlight.set(key, read);
  try {
    return await read;
  } catch (error) {
    readFolders.delete(key);
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  } finally {
    readsInFlight.delete(key);
  }
}

/** A base read that has started and not finished, which a second caller waits on. */
const readsInFlight = new Map<string, Promise<string>>();

/** As long as the slowest base read seen, a large monorepo's, with room to spare. */
const LOCK_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Every process reading one commit of one project writes its copy to the
 * same folder, so each one holds the folder's lock from clearing it to
 * removing it. A process that waited then finds the cache the first one
 * left, when `SUSS_CACHE_DIR` keeps it.
 */
async function readUnderLock(
  top: string,
  project: string,
  revision: BaseRevision,
  reads: DeclaredReads,
  work: string,
): Promise<string> {
  const tree = treeFor(top, project, revision.commit);
  const lock = await acquireFolderLock(
    `${path.dirname(tree)}.lock`,
    LOCK_TIMEOUT_MS,
  );
  try {
    return await readIntoTree(top, project, revision, reads, work, tree);
  } finally {
    releaseFolderLock(lock);
  }
}

async function readIntoTree(
  top: string,
  project: string,
  revision: BaseRevision,
  reads: DeclaredReads,
  work: string,
  tree: string,
): Promise<string> {
  fs.rmSync(path.dirname(tree), { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  writeRevision(top, revision.commit, work, tree);
  shareDependencies(top, tree);
  // Readers that measure a path from the repository look for this folder.
  fs.mkdirSync(path.join(tree, ".git"));

  const baseRoot = path.join(tree, path.relative(top, project));
  const present = reads.reads.filter((entry) =>
    fs.existsSync(path.resolve(baseRoot, inputOf(entry))),
  );
  process.stderr.write(
    `Reading ${revision.ref} at ${revision.commit.slice(0, 7)} into a temporary folder, with the same reads:\n${present.map((entry) => `  ${commandFor(entry)}`).join("\n")}\n`,
  );
  for (const entry of reads.reads.filter((one) => !present.includes(one))) {
    process.stderr.write(
      `  skipped, since ${inputOf(entry)} did not exist at ${revision.ref}: ${commandFor(entry)}\n`,
    );
  }

  // Every path a read writes is measured from the root it reads, so the
  // copy's summaries spell each file the way the checkout's do.
  const summaryDir = summariesIn(work);
  const report = await readProjectInto(
    baseRoot,
    summaryDir,
    {
      ...reads,
      reads: present.map((entry) => withPackConfigsFrom(project, entry)),
    },
    undefined,
    true,
  ).finally(() => {
    // The summaries are all a later question needs, and a large checkout
    // is most of the folder. Removing it leaves the linked node_modules alone.
    fs.rmSync(path.dirname(tree), { recursive: true, force: true });
  });
  if (report.failed.length > 0) {
    throw new UsageError(
      `Reading ${revision.ref} failed, and every unit those reads cover would look new:\n${report.failed.map((line) => `  ${line}`).join("\n")}`,
    );
  }
  return summaryDir;
}

/** The folder an extract reads, or the file a contract reads, relative to the project root. */
function inputOf(entry: ReadEntry): string {
  return entry.kind === "contract" ? entry.file : (entry.dir ?? ".");
}

/**
 * A pack's config file is part of how the project is read, so the base
 * is read with the working tree's copy. The base may not have it at all,
 * when it is new in the change or was never committed.
 */
function withPackConfigsFrom(project: string, entry: ReadEntry): ReadEntry {
  if (entry.kind === "contract") {
    return entry;
  }
  return { ...entry, packs: packSpecsOf(entry, project) };
}

/**
 * Where the base is written out. The extraction cache is keyed by the
 * folder it reads, and under `SUSS_CACHE_DIR` it outlives the copy, so
 * the folder is the same for every read of one commit of one project: a
 * second read of that commit finds its cache, and a new read adds no
 * cache folder of its own. The last part is named like the checkout, so
 * a summary that takes a workspace name from its folder reads the same
 * on both sides.
 */
function treeFor(top: string, project: string, commit: string): string {
  const key = createHash("sha256")
    .update(`${commit}\0${project}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    fs.realpathSync(os.tmpdir()),
    `suss-base-${key}`,
    path.basename(top),
  );
}

/** Lets the next `readBase` go back to git, for a caller that wants a cold read. */
export function forgetBaseReads(): void {
  for (const folder of readFolders.values()) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  readFolders.clear();
}

function summariesIn(work: string): string {
  return path.join(work, "summaries");
}

function temporaryFolder(): string {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      for (const folder of readFolders.values()) {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });
  }
  // The checkout is read at its resolved path, so the copy is too.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "suss-base-")));
}

let cleanupRegistered = false;

function gitTop(project: string): string {
  const top = git(project, ["rev-parse", "--show-toplevel"]);
  if (top === null) {
    throw new UsageError(
      `--base reads the base revision out of git, and ${project} is not inside a git repository. Compare two folders of summaries with --since instead.`,
    );
  }
  return fs.realpathSync(top.trim());
}

function resolveBase(project: string, ref: string): BaseRevision {
  const commit = git(project, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (commit === null) {
    throw new UsageError(
      `git does not know ${ref}. Fetch it first, for example \`git fetch origin main\`, or pass a commit.`,
    );
  }

  const shared = git(project, ["merge-base", ref, "HEAD"]);
  if (shared !== null) {
    return { ref, commit: shared.trim(), branchPoint: true };
  }
  process.stderr.write(
    `git could not find where HEAD left ${ref}, which happens in a shallow clone, so this compares with ${ref} itself. Anything that landed on ${ref} after the branch left it counts as part of the change. Fetching more history fixes it: git fetch --deepen=100 origin\n`,
  );
  return { ref, commit: commit.trim(), branchPoint: false };
}

function changedFiles(project: string, commit: string): string[] {
  const edited =
    git(project, ["diff", "--name-only", "--relative", commit]) ?? "";
  const added = git(project, ["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(
      `${edited}\n${added ?? ""}`
        .split("\n")
        .filter((line) => line.trim() !== "" && !isSussState(line)),
    ),
  ].sort();
}

/** suss's own cache and output folders, which a project that never ignored them has untracked. */
function isSussState(file: string): boolean {
  return file.split("/").includes(".suss");
}

function writeRevision(
  top: string,
  commit: string,
  work: string,
  tree: string,
): void {
  const archive = path.join(work, "base.tar");
  if (git(top, ["archive", "--format=tar", "-o", archive, commit]) === null) {
    throw new UsageError(`git could not write ${commit} out of ${top}.`);
  }
  execFileSync("tar", ["-xf", archive, "-C", tree], { stdio: "ignore" });
  fs.rmSync(archive, { force: true });
}

/**
 * Dependencies rarely change in one branch, and installing them again
 * would take longer than the read, so the base uses the working tree's
 * `node_modules` folders. A type from a package the branch upgraded
 * resolves through the new version on both sides.
 */
function shareDependencies(top: string, tree: string): void {
  const pending = [""];
  while (pending.length > 0) {
    const folder = pending.pop() ?? "";
    const installed = path.join(top, folder, "node_modules");
    const linked = path.join(tree, folder, "node_modules");
    if (fs.existsSync(installed) && !fs.existsSync(linked)) {
      fs.symlinkSync(installed, linked, "junction");
    }

    for (const entry of fs.readdirSync(path.join(tree, folder), {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== ".git"
      ) {
        pending.push(path.join(folder, entry.name));
      }
    }
  }
}

/** git's output, or null when it exits non-zero. */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
