#!/usr/bin/env node
// land.mjs - rebase a pull request branch that is clear to land but has
// gone stale against main on generated files.
//
//   node scripts/land.mjs 123
//   node scripts/land.mjs 123 --dry-run
//   node scripts/land.mjs 123 --regenerate
//
// Through npm it is `npm run land`, with npm's "--" separator before
// the arguments.
//
// After a branch is verified, main tends to move under it: every merge
// makes the regenerate workflow refresh the dogfood baseline, the
// coverage summaries, and the badges, and the branch's copies of those
// files now conflict. Nothing about the branch is wrong, but someone
// still has to rebase it, rerun the generators, and push. This script
// does that round.
//
// It rebases the branch onto origin/main in a temporary worktree, never
// in the checkout it was invoked from. A conflict inside the generated
// groups is resolved by taking main's side, and the generators then
// rerun so the branch's own numbers land back in the files, gated by
// typecheck, check:dogfood, and check:coverage. A conflict anywhere else aborts the
// rebase and exits nonzero, because that is a change a person has to
// read. The push uses --force-with-lease against the head this run
// started from. Nothing here merges the PR.
//
// --branch <name> targets a branch on origin directly, without a PR. It
// exists so this script can be exercised against a throwaway branch;
// the PR number stays the normal interface.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The path groups a full run of the suite rewrites. A conflict here is
 * resolved by taking main's side and regenerating; a conflict anywhere
 * else stops the script.
 *
 * The regenerate workflow (.github/workflows/regenerate.yml) stages the
 * same three groups when it refreshes main after a merge. A workflow
 * cannot import a module, so when this list changes, the staging list
 * there has to change with it.
 *
 * Each entry pairs the pathspec used to stage the group with the pattern
 * that decides whether a conflicted path belongs to it. Every pattern is
 * anchored at both ends and matches whole path segments, because
 * whatever these accept is resolved without a person reading it: a
 * substring test would hand main's side to a source file under some
 * directory that merely ends in the same letters.
 */
export const GENERATED_PATH_GROUPS = [
  {
    pathspec: "scripts/dogfood-baseline.json",
    pattern: /^scripts\/dogfood-baseline\.json$/,
  },
  {
    pathspec: "packages/**/coverage/coverage-summary.json",
    pattern: /^packages\/(?:[^/]+\/)+coverage\/coverage-summary\.json$/,
  },
  {
    pathspec: ".github/badges/*.svg",
    pattern: /^\.github\/badges\/[^/]+\.svg$/,
  },
];

const USAGE = [
  "Usage:",
  "  node scripts/land.mjs <pr-number> [--dry-run] [--regenerate]",
  "  node scripts/land.mjs --branch <name> [--dry-run] [--regenerate]",
  '  (through npm: npm run land, with the "--" separator before the arguments)',
].join("\n");

class Abort extends Error {}

/** The temporary worktree's path while one exists, so the exit paths can remove it. */
let worktree = null;

/**
 * Whether git registered the worktree, as opposed to mkdtemp having only
 * made the directory. It decides which of the two removals can work if
 * cleanup has to tell someone to finish the job by hand.
 */
let worktreeRegistered = false;

/** The command running right now, so a signal can stop it. */
let activeChild = null;

let values = {};
let positionals = [];
let dryRun = false;

// Running this file does the landing; importing it only reads the path
// groups above, which is how a test gets at them without a rebase
// happening as a side effect of the import.
if (path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  handleSignals();
  readCommandLine();
  runAndExit();
}

/**
 * Run the same cleanup on Ctrl-C and on a kill.
 *
 * A run spends most of its time inside an install, a build, or the test
 * suite, and an interrupt there would otherwise kill node outright: the
 * default disposition for both of these terminates the process without
 * unwinding, so `finally` never runs and a registered worktree, possibly
 * stopped mid-rebase, is left behind on disk.
 */
function handleSignals() {
  for (const [signal, number] of [
    ["SIGINT", 2],
    ["SIGTERM", 15],
  ]) {
    process.on(signal, () => {
      console.error(`\nStopped by ${signal}. Cleaning up.`);
      killActiveChild(signal);
      removeWorktree();
      process.exit(128 + number);
    });
  }
}

function readCommandLine() {
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        branch: { type: "string" },
        "dry-run": { type: "boolean" },
        regenerate: { type: "boolean" },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  dryRun = values["dry-run"] === true;
}

async function runAndExit() {
  let exitCode = 0;
  try {
    await main();
  } catch (err) {
    if (!(err instanceof Abort)) {
      throw err;
    }

    console.error(`\n${err.message}`);
    exitCode = 1;
  } finally {
    removeWorktree();
  }
  process.exit(exitCode);
}

async function main() {
  const branch = resolveBranch();

  console.log(`Fetching origin/main and origin/${branch}.`);
  if (!(await succeeds("git", ["fetch", "origin", "main", branch]))) {
    fail(
      `Could not fetch origin/${branch}. The usual reason is that the branch is gone from origin, which happens when a merged or closed PR had its head branch deleted.`,
    );
  }

  // The head the branch had when this run started. The push at the end
  // leases against exactly this, so a push that lands in between makes
  // the lease fail instead of being overwritten.
  const startedFrom = capture("git", [
    "rev-parse",
    `refs/remotes/origin/${branch}`,
  ]);
  const mainSha = capture("git", ["rev-parse", "refs/remotes/origin/main"]);

  worktree = mkdtempSync(path.join(tmpdir(), "suss-land-"));
  if (
    !(await succeeds("git", [
      "worktree",
      "add",
      "--detach",
      worktree,
      startedFrom,
    ]))
  ) {
    fail("Could not create the temporary worktree, so nothing was changed.");
  }
  worktreeRegistered = true;
  console.log(`Working in a temporary worktree at ${worktree}.`);

  const taken = await rebaseOntoMain(branch);

  if (taken.size > 0) {
    console.log(
      `Took main's side of ${taken.size} generated ${plural(taken.size, "file")}:`,
    );
    for (const file of [...taken].sort()) {
      console.log(`  ${file}`);
    }
  }

  if (taken.size > 0 || values.regenerate === true) {
    await regenerate(branch);
  } else {
    console.log(
      "The rebase had no generated conflicts, so the generators were not rerun. Pass --regenerate to rerun them anyway.",
    );
  }

  const head = capture("git", ["rev-parse", "HEAD"], { cwd: worktree });

  if (head === startedFrom) {
    console.log(
      `origin/${branch} already sits on origin/main and nothing changed, so there is nothing to push.`,
    );
    return;
  }

  // Pushing this would replace the PR's commits with nothing and leave
  // an open PR whose diff is empty, which reads as the branch having
  // been landed rather than emptied. Whatever did that (an upstream
  // cherry-pick, a rebase that skipped every commit) is worth someone
  // looking at before the branch is overwritten.
  if (head === mainSha) {
    fail(
      `After the rebase, ${branch} carries no commits of its own: its head is origin/main exactly. Pushing that would empty the pull request, so nothing was pushed. Check whether the work already landed on main some other way.`,
    );
  }

  if (dryRun) {
    console.log(
      `Dry run, stopping before the push. Would push ${head} to origin/${branch} with --force-with-lease, replacing ${startedFrom}.`,
    );
    return;
  }

  // HUSKY=0 skips the pre-push hook. It would rerun the suite this
  // script already ran when it regenerated, and on a rebase with no
  // generated conflicts the worktree has no node_modules for the hook
  // to run with. The PR's own CI reruns on the push either way.
  await run(
    "git",
    [
      "push",
      `--force-with-lease=refs/heads/${branch}:${startedFrom}`,
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    { cwd: worktree, env: { HUSKY: "0" } },
  );
  console.log(`Pushed. origin/${branch} is now at ${head}.`);
  console.log("This script never merges; merge the PR when you are ready.");
}

/**
 * The branch to land, from the PR number or from --branch.
 *
 * The refusal to rewrite main comes at the end, where it sees whatever
 * either path resolved to. A same-repo pull request can be opened with
 * main as its head branch, and everything else here passes it: it is
 * not cross-repository and it is open.
 */
function resolveBranch() {
  const branch = branchFromArguments();

  if (branch === "main") {
    fail("Refusing to rewrite main.");
  }

  return branch;
}

function branchFromArguments() {
  if (values.branch !== undefined && positionals.length > 0) {
    fail("Give a PR number or --branch, not both.");
  }

  if (values.branch !== undefined) {
    return values.branch;
  }

  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
    fail(USAGE);
  }

  return branchOfPullRequest(positionals[0]);
}

function branchOfPullRequest(number) {
  const pr = JSON.parse(readPullRequest(number));

  if (pr.isCrossRepository) {
    fail(
      `PR #${number} comes from a fork, and this script only pushes branches that live on origin.`,
    );
  }

  if (pr.state !== "OPEN") {
    fail(
      `PR #${number} is ${pr.state.toLowerCase()}, so there is nothing to land.`,
    );
  }

  console.log(`PR #${number} is branch ${pr.headRefName}.`);
  return pr.headRefName;
}

/**
 * What gh knows about the pull request, as JSON.
 *
 * gh writes its own explanation to stderr and exits nonzero for a number
 * that is not a pull request and for a machine that is not logged in.
 * Passing that through as an Abort keeps those two looking like every
 * other way this script stops, rather than a stack trace.
 */
function readPullRequest(number) {
  try {
    return execFileSync(
      "gh",
      ["pr", "view", number, "--json", "headRefName,isCrossRepository,state"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    const said = String(err.stderr ?? "").trim();
    fail(
      `Could not read PR #${number} with gh.${said === "" ? "" : `\n\n${said}`}`,
    );
  }
}

/**
 * Rebase the worktree onto origin/main, taking main's side of any
 * conflict inside the generated groups. Returns the paths that were
 * taken. A conflict outside those groups aborts the rebase and stops
 * the script.
 */
async function rebaseOntoMain(branch) {
  console.log(`Rebasing ${branch} onto origin/main.`);

  const taken = new Set();
  let done = await succeeds("git", ["rebase", "origin/main"], {
    cwd: worktree,
    env: { GIT_EDITOR: "true" },
  });

  while (!done) {
    const conflicted = listConflicts();

    if (conflicted.length === 0) {
      trySilently("git", ["rebase", "--abort"], worktree);
      fail(
        "The rebase stopped without any conflicted paths, which this script does not handle. It was aborted; run the rebase by hand to see what happened.",
      );
    }

    const source = conflicted.filter((file) => !isGenerated(file));

    if (source.length > 0) {
      await succeeds("git", ["rebase", "--abort"], { cwd: worktree });
      const generated = conflicted.length - source.length;
      fail(
        "The rebase conflicts on files outside the generated groups, so a person has to resolve it:\n" +
          source.map((file) => `  ${file}`).join("\n") +
          (generated > 0
            ? `\nAnother ${generated} generated ${plural(generated, "file")} conflicted too; those would have been taken from main.`
            : "") +
          "\nThe rebase was aborted and nothing was pushed.",
      );
    }

    const tookOurs = await succeeds(
      "git",
      ["checkout", "--ours", "--", ...conflicted],
      { cwd: worktree },
    );

    if (!tookOurs) {
      trySilently("git", ["rebase", "--abort"], worktree);
      fail(
        "Taking main's side of a generated conflict failed, which usually means one side deleted the file. The rebase was aborted; resolve it by hand.",
      );
    }

    await run("git", ["add", "--", ...conflicted], { cwd: worktree });

    for (const file of conflicted) {
      taken.add(file);
    }

    // Taking main's side can leave a commit with nothing of its own,
    // and `git rebase --continue` refuses to record an empty commit.
    const nothingStaged = await succeeds(
      "git",
      ["diff", "--cached", "--quiet"],
      { cwd: worktree },
    );
    done = await succeeds(
      "git",
      ["rebase", nothingStaged ? "--skip" : "--continue"],
      { cwd: worktree, env: { GIT_EDITOR: "true" } },
    );
  }

  return taken;
}

/**
 * Rerun everything that writes the generated files, gate on the checks,
 * and commit what changed.
 */
async function regenerate(branch) {
  if (!existsSync(path.join(worktree, "node_modules"))) {
    console.log("Installing dependencies in the worktree.");
    await run("npm", ["ci"], { cwd: worktree });
  }

  console.log("Rebuilding and regenerating baselines and badges.");
  await run("npm", ["run", "build", "--", "--force"], { cwd: worktree });

  // The push below skips the pre-push hook, and typecheck is the first
  // thing that hook runs. Without it here, a branch whose types no
  // longer match the main underneath it is pushed anyway and fails in
  // CI instead.
  if (!(await succeeds("npm", ["run", "typecheck"], { cwd: worktree }))) {
    fail(
      `typecheck failed on the rebased tree, so nothing was pushed. origin/${branch} is untouched. The branch and the main under it no longer agree on types.`,
    );
  }

  await run("npm", ["run", "test:coverage"], { cwd: worktree });
  await run("npm", ["run", "badges"], { cwd: worktree });
  await run("npm", ["run", "dogfood"], { cwd: worktree });

  for (const gate of ["check:dogfood", "check:coverage"]) {
    if (!(await succeeds("npm", ["run", gate], { cwd: worktree }))) {
      fail(
        `${gate} failed on the rebased tree, so nothing was pushed. origin/${branch} is untouched.`,
      );
    }
  }

  const pathspecs = GENERATED_PATH_GROUPS.map((group) => group.pathspec);
  await run("git", ["add", "--", ...pathspecs], { cwd: worktree });

  if (
    await succeeds("git", ["diff", "--cached", "--quiet"], { cwd: worktree })
  ) {
    console.log("The regenerated files match what the branch already commits.");
    return;
  }

  await run(
    "git",
    ["commit", "-m", "chore: regenerate baselines after rebase"],
    { cwd: worktree, env: { HUSKY: "0" } },
  );
  console.log("Committed the regenerated files.");
}

function isGenerated(file) {
  return GENERATED_PATH_GROUPS.some((group) => group.pattern.test(file));
}

function listConflicts() {
  const output = capture("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: worktree,
  });

  if (output === "") {
    return [];
  }

  return output.split("\n");
}

function removeWorktree() {
  if (worktree === null) {
    return;
  }

  const dir = worktree;
  const registered = worktreeRegistered;
  worktree = null;
  worktreeRegistered = false;

  // mkdtemp made the directory before `git worktree add` ran, and the
  // add can fail. git knows nothing about the directory in that case, so
  // `git worktree remove` would fail too and telling someone to run it
  // sends them at the one command that cannot work.
  if (!registered) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      console.error(
        `Could not remove the temporary directory; run \`rm -rf ${dir}\` yourself.`,
      );
    }
    return;
  }

  // A rebase still in progress would keep state under the worktree's
  // git dir; aborting it first lets the removal go through.
  trySilently("git", ["rebase", "--abort"], dir);
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    console.error(
      `Could not remove the temporary worktree; run \`git worktree remove --force ${dir}\` yourself.`,
    );
  }
}

/**
 * Run a command with its output streaming through, and say whether it
 * came back zero.
 *
 * Every child gets its own process group, and nothing here waits for
 * the command synchronously. Both halves of that matter. An async wait
 * leaves the event loop free, so a signal is handled the moment it
 * arrives rather than whenever the command happens to finish, which is
 * what execFileSync did. And the group is what gets killed, because a
 * command that dies can leave workers behind it: killing npm alone
 * leaves turbo and the vitest workers running.
 *
 * The group is reaped when the command closes, whatever it exited with,
 * so an ordinary failure clears up after itself the same way an
 * interrupt does. A command that left nothing behind reaps in one check
 * and costs nothing.
 */
function runChild(command, args, { cwd = ROOT, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      detached: true,
      env: env === undefined ? process.env : { ...process.env, ...env },
    });
    activeChild = child;

    const finish = async (ok) => {
      activeChild = null;
      await reapProcessGroup(child.pid);
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Stop anything still running in a finished command's process group.
 *
 * The command itself has already gone; what can remain is whatever it
 * started and did not stop on its way out, which is what a crashed test
 * runner leaves behind. They are given a term first and a kill only if
 * they sit through it.
 */
async function reapProcessGroup(pid) {
  if (pid === undefined || !groupHasMembers(pid)) {
    return;
  }

  signalGroup(pid, "SIGTERM");

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (!groupHasMembers(pid)) {
      return;
    }
  }

  console.error(
    "Some of what that command started is still running after being asked to stop; killing it.",
  );
  signalGroup(pid, "SIGKILL");
}

/**
 * Whether anything is still in the group.
 *
 * Signal 0 asks without sending anything. Only "no such process" means
 * the group is empty: a group this cannot signal is still a group with
 * something in it.
 */
function groupHasMembers(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a command, stopping the script when it fails. */
async function run(command, args, options = {}) {
  if (!(await runChild(command, args, options))) {
    fail(`\`${command} ${args.join(" ")}\` failed, so nothing was pushed.`);
  }
}

/** Like run, but hand back the failure instead of stopping. */
async function succeeds(command, args, options = {}) {
  return await runChild(command, args, options);
}

/**
 * Stop whatever command is running, and everything it started.
 *
 * This one cannot wait between the two signals the way reaping does,
 * because the caller exits the process as soon as it returns.
 */
function killActiveChild(signal) {
  if (activeChild === null) {
    return;
  }

  const { pid } = activeChild;
  activeChild = null;

  if (pid === undefined) {
    return;
  }

  signalGroup(pid, signal);
  signalGroup(pid, "SIGKILL");
}

/** Run a command and hand back its stdout, trimmed. */
function capture(command, args, { cwd = ROOT } = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

/** Run a command for its side effect only, swallowing any failure. */
function trySilently(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: "ignore" });
  } catch {
    // Best effort only.
  }
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

function fail(message) {
  throw new Abort(message);
}
