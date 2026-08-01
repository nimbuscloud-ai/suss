#!/usr/bin/env node
// changelog.mjs - turn the commits since the last release into notes.
//
//   node scripts/changelog.mjs
//   node scripts/changelog.mjs --version 0.1.0 --output notes.md
//   node scripts/changelog.mjs --from v0.0.2 --to HEAD
//
// The range runs from the newest v* tag that HEAD can reach up to HEAD.
// Before the first tag exists there is nothing to start from, so the
// notes start at the first commit in the repository and say so.
//
// A subject is read as a conventional commit, `type(scope): summary`,
// and lands under a heading for its type. Anything that does not parse
// still gets a line, under "Other changes", because a subject nobody
// wrote in that shape is still a change someone wants to read about.
//
// Squash merges end their subject with the pull request number, as in
// `fix(cli): stop the spinner (#41)`, and that number becomes a link.
// A commit that landed without one links to the commit instead, so
// every line leads somewhere.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Headings, in the order they appear. A type not listed sorts last. */
const TYPES = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "Continuous integration"],
  ["style", "Style"],
  ["chore", "Chores"],
  ["revert", "Reverts"],
];

const OTHER = "Other changes";

const CONVENTIONAL =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<summary>.+)$/;
const TRAILING_PR = /\s*\(#(?<number>\d+)\)\s*$/;

// What a release commit's subject looks like. It describes a release
// rather than anything in one, so it opens a range and never appears
// inside one. Written so that git reads it as an extended regular
// expression and JavaScript reads it the same way.
const RELEASE_SUBJECT = "^chore(\\([^)]*\\))?: release [0-9]";
const RELEASE_COMMIT = new RegExp(RELEASE_SUBJECT);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: "string" },
    to: { type: "string", default: "HEAD" },
    version: { type: "string" },
    output: { type: "string" },
  },
});

const to = values.to;
const from = values.from ?? previousRelease();
const repository = repositoryUrl();

const notes = render(readCommits(from, to), {
  from,
  to,
  version: values.version,
  repository,
});

if (values.output === undefined) {
  process.stdout.write(`${notes}\n`);
} else {
  fs.writeFileSync(path.resolve(ROOT, values.output), `${notes}\n`);
  console.error(`Wrote ${values.output} for ${from}..${to}.`);
}

// ---------------------------------------------------------------------

/**
 * Where the last release ended.
 *
 * Its tag says so first. `git describe` reads only tags the range end
 * can reach, so a tag on another branch cannot open the range. Failing
 * that, the commit the last release wrote is as good a mark, and 0.0.2
 * went out with one of those and no tag behind it. A repository that
 * has released nothing starts at its first commit.
 */
function previousRelease() {
  const tag = attempt([
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v*",
    to,
  ]);
  if (tag !== undefined) {
    return tag;
  }

  const releaseCommit = attempt([
    "log",
    "--format=%H",
    `--grep=${RELEASE_SUBJECT}`,
    "--extended-regexp",
    "--max-count=1",
    to,
  ]);
  if (releaseCommit !== undefined && releaseCommit !== "") {
    console.error(
      `No v* tag is reachable from ${to}. Starting at the last release commit,` +
        ` ${releaseCommit.slice(0, 7)}.`,
    );
    return releaseCommit;
  }

  const first = git(["rev-list", "--max-parents=0", to]).split("\n")[0];
  console.error(
    `Nothing has been released from ${to} yet, so the notes start at the first commit.`,
  );
  return first;
}

function attempt(args) {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

/** Where pull request and commit links point. */
function repositoryUrl() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const url = manifest.repository?.url ?? "";
  const match = url.match(/github\.com[/:](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/);
  return match === null ? undefined : `https://github.com/${match.groups.slug}`;
}

function readCommits(start, end) {
  // A record separator, then field separators, so a subject or a body
  // containing a newline cannot be mistaken for the next commit.
  const log = git([
    "log",
    "--no-merges",
    "--format=%x1e%H%x1f%s%x1f%b",
    `${start}..${end}`,
  ]);

  return log
    .split("\x1e")
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, subject, body] = record.split("\x1f");
      return { sha, subject: subject.trim(), body: body ?? "" };
    })
    .filter(({ subject }) => !RELEASE_COMMIT.test(subject))
    .map(describe);
}

/** Read one commit into the pieces a note is written from. */
function describe({ sha, subject, body }) {
  const pull = subject.match(TRAILING_PR)?.groups.number;
  const withoutPull = subject.replace(TRAILING_PR, "");
  const parsed = withoutPull.match(CONVENTIONAL)?.groups;
  const breaking =
    parsed?.breaking === "!" || /^BREAKING[ -]CHANGE:/m.test(body);

  if (parsed === undefined) {
    return { sha, pull, breaking, heading: OTHER, summary: withoutPull };
  }
  return {
    sha,
    pull,
    breaking,
    heading: headingFor(parsed.type),
    scope: parsed.scope,
    summary: parsed.summary,
  };
}

function headingFor(type) {
  return TYPES.find(([name]) => name === type)?.[1] ?? OTHER;
}

function render(commits, { from, to, version, repository }) {
  if (commits.length === 0) {
    return `Nothing has landed since ${from}.`;
  }

  const sections = [];

  // A breaking change is repeated under its own type below. Someone
  // reading for what will break should not have to find it there.
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    sections.push(section("Breaking changes", breaking, repository));
  }

  const order = [...TYPES.map(([, heading]) => heading), OTHER];
  for (const heading of order) {
    const inSection = commits.filter((commit) => commit.heading === heading);
    if (inSection.length > 0) {
      sections.push(section(heading, inSection, repository));
    }
  }

  const footer = compareLink({ from, to, version, repository });
  if (footer !== undefined) {
    sections.push(footer);
  }

  return sections.join("\n\n");
}

function section(heading, commits, repository) {
  const lines = commits.map((commit) => entry(commit, repository));
  return `### ${heading}\n\n${lines.join("\n")}`;
}

function entry({ sha, pull, scope, summary }, repository) {
  const prefix = scope === undefined ? "" : `**${scope}:** `;
  return `- ${prefix}${summary} (${reference({ sha, pull }, repository)})`;
}

function reference({ sha, pull }, repository) {
  const short = sha.slice(0, 7);
  if (repository === undefined) {
    return pull === undefined ? `\`${short}\`` : `#${pull}`;
  }
  if (pull === undefined) {
    return `[\`${short}\`](${repository}/commit/${sha})`;
  }
  return `[#${pull}](${repository}/pull/${pull})`;
}

/**
 * A link to the whole diff. The end of the range is the tag this
 * release is about to carry, which the workflow pushes before it puts
 * the notes anywhere a reader can reach them.
 */
function compareLink({ from, to, version, repository }) {
  if (repository === undefined) {
    return undefined;
  }
  const end = version === undefined ? to : `v${version}`;
  return `**Full changelog**: ${repository}/compare/${from}...${end}`;
}

function git(args) {
  // git's own stderr stays captured, because a command that fails here
  // has a fallback and its complaint would read as an error.
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
