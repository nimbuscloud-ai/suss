// harness.ts: run the built suss binary the way a person runs it.
//
// Every test in this package spawns `node packages/cli/dist/bin.js`
// in a working directory holding files on disk, and reads back what a
// person would read: the exit code, what landed on stdout and stderr,
// and what appeared beside the code. Nothing here imports a CLI
// function.
//
// That restriction is the whole point of the package. A test that
// imports `inspectProject` passes while the code printing its result
// throws the findings away, and a test that imports `extract` passes
// while the flag that would have reached it never parses. Both of
// those shipped. The only way to fail with the person is to run what
// the person runs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The binary an `npm install @suss/cli` puts on a person's PATH. */
export const SUSS_BIN = path.resolve(
  import.meta.dirname,
  "../../../packages/cli/dist/bin.js",
);

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "../../../fixtures");

export interface RunOptions {
  /** Where the command runs. Defaults to the repository root. */
  cwd?: string;
}

export interface Run {
  /** What the command exited with. `null` means it was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, in the order a terminal would not
   * guarantee but a person reads them anyway. Useful when a message
   * could reasonably go to either stream. */
  output: string;
}

/**
 * Run `suss <args>` and hand back what a person sees.
 *
 * Failure is a result, not a throw: a journey that asserts on the
 * sentence printed for an unreadable project needs the sentence and
 * the exit code, and a harness that threw would give it neither.
 */
export function runSuss(args: string[], options: RunOptions = {}): Run {
  const result = spawnSync(process.execPath, [SUSS_BIN, ...args], {
    cwd: options.cwd ?? path.resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 120_000,
    // A pipe rather than a terminal, which is what CI gives the
    // command anyway, and what makes `init` print instead of prompt.
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

/** A fixture project, read where it lives. */
export function fixture(name: string): string {
  const dir = path.join(FIXTURES_ROOT, name);
  if (!fs.existsSync(dir)) {
    throw new Error(`No fixture named ${name} under ${FIXTURES_ROOT}.`);
  }

  return dir;
}

/**
 * An empty directory the test owns, removed when the test file is
 * done. Summaries, config files, and anything the command writes go
 * here, so a journey never leaves anything in the repository.
 */
export function workspace(label: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `suss-acceptance-${label}-`),
  );
  temporaryDirectories.push(dir);
  return dir;
}

/**
 * A writable copy of a fixture project, for a journey where the person
 * writes something next to their own code: a pack's config file, a
 * summaries folder, a `.sussignore`.
 */
export function copyOfFixture(name: string, label = name): string {
  const dir = path.join(workspace(label), "project");
  fs.cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

/** Every file under a directory, relative to it, sorted. */
export function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** Read a JSON file the command wrote. */
export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Write a pack's config file, the way the guides tell a person to.
 * Returns the path, to hand straight to `-f <pack>=<file>`.
 */
export function writePackConfig(
  dir: string,
  pack: string,
  config: unknown,
): string {
  const file = path.join(dir, `suss.${pack}.json`);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

const temporaryDirectories: string[] = [];

/** Called from a global teardown so no journey has to remember. */
export function removeTemporaryDirectories(): void {
  for (const dir of temporaryDirectories) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
}
