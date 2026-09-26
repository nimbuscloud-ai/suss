/**
 * Which suss the hooks run, and running it.
 *
 * The project's own suss comes first, the one `node_modules/.bin/suss`
 * runs, provided it is the release this plugin was built against or a
 * newer one, because the hooks use flags older releases lack. Then the
 * plugin's own copy: a `@suss/cli` installed beside the plugin, or else
 * the pinned release fetched once through npx. The pin is the plugin's
 * version, which moves in step with suss.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readJson } from "./session.mjs";

/** @typedef {import("./types.js").SussCommand} SussCommand */
/** @typedef {import("./types.js").SussRun} SussRun */

/**
 * The suss release this plugin was built against.
 *
 * @param {string} pluginRoot
 * @returns {string | null}
 */
export function pinnedVersion(pluginRoot) {
  const manifest = readJson(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    { version: null },
  );
  return typeof manifest.version === "string" ? manifest.version : null;
}

/**
 * How to run one of suss's executables: the project's copy, the
 * plugin's, or the pinned release through npx.
 *
 * @param {{ pkg: string, bin: string, projectDir: string, pluginRoot: string }} where
 * @returns {SussCommand}
 */
export function findExecutable({ pkg, bin, projectDir, pluginRoot }) {
  const pinned = pinnedVersion(pluginRoot);
  const project = installedBin(pkg, bin, projectDir, "project");
  if (project !== null && atLeast(project.version, pinned)) {
    return project;
  }

  const own = installedBin(pkg, bin, pluginRoot, "plugin");
  if (own !== null) {
    return own;
  }
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    prefix: ["--yes", `--package=${pkg}@${pinned ?? "latest"}`, bin],
    from: "npx",
    version: pinned,
    shell: process.platform === "win32",
  };
}

/**
 * @param {string} projectDir
 * @param {string} pluginRoot
 */
export function findSuss(projectDir, pluginRoot) {
  return findExecutable({
    pkg: "@suss/cli",
    bin: "suss",
    projectDir,
    pluginRoot,
  });
}

/**
 * The package's executable, looked up the way node looks up a package:
 * in `node_modules` here and in every directory above.
 *
 * @param {string} pkg
 * @param {string} bin
 * @param {string} fromDir
 * @param {SussCommand["from"]} from
 * @returns {SussCommand | null}
 */
function installedBin(pkg, bin, fromDir, from) {
  for (const dir of directoriesUp(path.resolve(fromDir))) {
    const manifestPath = path.join(dir, "node_modules", pkg, "package.json");
    const manifest =
      /** @type {{ bin?: string | Record<string, string>, version?: string } | null} */ (
        readJson(manifestPath, null)
      );
    if (manifest === null) {
      continue;
    }

    const relative =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
    const file =
      typeof relative === "string"
        ? path.join(path.dirname(manifestPath), relative)
        : null;
    // A workspace checkout that was never built has the manifest and no
    // executable, so keep looking.
    if (file === null || !fs.existsSync(file)) {
      continue;
    }
    return {
      command: process.execPath,
      prefix: [file],
      from,
      version: typeof manifest.version === "string" ? manifest.version : null,
      shell: false,
    };
  }
  return null;
}

/** @param {string} start */
function directoriesUp(start) {
  const dirs = [start];
  let dir = start;
  while (path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Whether `version` is `wanted` or newer, comparing the three numbers.
 *
 * @param {string | null} version
 * @param {string | null} wanted
 */
export function atLeast(version, wanted) {
  if (wanted === null) {
    return true;
  }
  const have = numbersOf(version);
  const need = numbersOf(wanted);
  if (have === null || need === null) {
    return false;
  }
  for (const [index, part] of need.entries()) {
    const own = have[index] ?? 0;
    if (own !== part) {
      return own > part;
    }
  }
  return true;
}

/** @param {string | null} version */
function numbersOf(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match === null ? null : match.slice(1).map(Number);
}

/**
 * Runs suss and collects what it printed. Never rejects: a run that
 * could not start, or ran past its deadline, comes back with `failure`.
 *
 * @param {SussCommand} suss
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs: number, onSpawn?: (child: import("node:child_process").ChildProcess) => void }} options
 * @returns {Promise<SussRun>}
 */
export function runSuss(suss, args, options) {
  return new Promise((resolve) => {
    const child = spawn(suss.command, [...suss.prefix, ...args], {
      cwd: options.cwd,
      shell: suss.shell,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUSS_NO_UPDATE_NOTICE: "1" },
    });
    options.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let late = false;
    let settled = false;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => {
      late = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    /** @param {SussRun} run */
    const finish = (run) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(run);
    };
    child.on("error", (error) => {
      finish({
        code: null,
        stdout,
        stderr,
        failure: `suss could not start: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      finish({
        code,
        stdout,
        stderr,
        ...(late
          ? {
              failure: `suss did not finish within ${Math.round(options.timeoutMs / 1000)}s`,
            }
          : {}),
      });
    });
  });
}

/**
 * The first lines of what a failed run printed, for a note the agent or
 * the developer reads.
 *
 * @param {SussRun} run
 */
export function whyItFailed(run) {
  const printed = run.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(" ");
  return (
    run.failure ?? (printed.length > 0 ? printed : `suss exited ${run.code}`)
  );
}
