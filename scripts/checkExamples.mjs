#!/usr/bin/env node
// checkExamples.mjs: run the commands the documentation shows, and compare
// what comes back to what the page says comes back. A page can only be run
// once it is annotated, and CONTRIBUTING.md says how (#560).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandIncludes } from "./docsIncludes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");
const FIXTURES = path.join(ROOT, "fixtures");
const SUSS_BIN = path.join(ROOT, "packages", "cli", "dist", "bin.js");

/** A paragraph introducing a file: a backticked path with an extension on
 * it, then a colon. */
const FILE_INTRO = /^`([\w./-]+\.[a-z0-9]{1,5})`[\s\S]*:$/;

/** A line that starts something other than a paragraph, so a fence below it
 * has moved on from the fence above it. */
const NOT_PROSE = /^\s*(#|[-*+]\s|\d+\.\s|\||>)/;

/** How much prose can sit between a command and its output and still read as
 * one pair. */
const PROSE_LINE_BUDGET = 10;

function* markdownFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* markdownFiles(full);
    } else if (entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

/** A page's lines with its includes expanded, and for each one the line of
 * the page it came from, so a failure points at the page. */
function pageLines(file) {
  const lines = [];
  const origins = [];
  const source = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < source.length; i++) {
    for (const line of expandIncludes(source[i], file, DOCS).split("\n")) {
      lines.push(line);
      origins.push(i + 1);
    }
  }
  return { lines, origins };
}

/** A page as fences, suss annotations and paragraphs, in the order they
 * appear. Everything else is dropped. */
function itemsOf({ lines, origins }) {
  const items = [];
  let paragraph = null;

  const endParagraph = () => {
    if (paragraph !== null) {
      items.push(paragraph);
      paragraph = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    // A code group's tab title comes after the language: ```md [Cursor]
    const fence = lines[i].match(/^```([^\s[{`]*)[^`]*$/);
    if (fence !== null) {
      endParagraph();
      const start = i;
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        i++;
      }
      items.push({
        type: "fence",
        lang: fence[1],
        body: lines.slice(start + 1, i),
        line: origins[start],
      });
      continue;
    }

    const note = lines[i].match(/^<!--\s*suss:(\w+)\s*([\s\S]*?)\s*-->\s*$/);
    if (note !== null) {
      endParagraph();
      items.push({
        type: "note",
        name: note[1],
        rest: note[2],
        line: origins[i],
      });
      continue;
    }

    if (lines[i].trim() === "") {
      endParagraph();
      continue;
    }

    if (paragraph === null) {
      paragraph = { type: "paragraph", lines: [], line: origins[i] };
    }
    paragraph.lines.push(lines[i]);
  }

  endParagraph();
  return items;
}

/** For each output fence, the bash fence whose output it presents, if the
 * page reads that way. Prose between the two is fine; a heading, a list or a
 * table means the fence below is about something else. */
function pairingsIn(items) {
  const pairs = new Map();

  for (let i = 0; i < items.length; i++) {
    if (items[i].type !== "fence" || items[i].lang !== "bash") {
      continue;
    }

    let prose = 0;
    for (let j = i + 1; j < items.length; j++) {
      const item = items[j];
      if (item.type === "note") {
        continue;
      }
      if (item.type === "paragraph") {
        if (item.lines.some((line) => NOT_PROSE.test(line))) {
          break;
        }
        prose += item.lines.length;
        if (prose > PROSE_LINE_BUDGET) {
          break;
        }
        continue;
      }
      if (item.lang === "") {
        pairs.set(j, i);
      }
      break;
    }
  }

  return pairs;
}

/** The suss command a line runs, or null when it runs something else. */
function sussCommand(line) {
  const words = tokenize(line);
  if (words.length === 0) {
    return null;
  }
  if (words[0] === "npx") {
    words.shift();
  }
  if (words[0] !== "suss" && words[0] !== "@suss/cli") {
    return null;
  }
  words.shift();
  return words;
}

/** Shell words, honouring quotes and stopping at a trailing comment. */
function tokenize(line) {
  const words = [];
  let word = "";
  let quote = null;

  for (const character of line) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && word === "") {
      break;
    }
    if (/\s/.test(character)) {
      if (word !== "") {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += character;
  }

  if (word !== "") {
    words.push(word);
  }
  return words;
}

/** The npm or npx command a line runs, other than suss, or null. */
function packageCommand(line) {
  const words = tokenize(line);
  if (words[0] !== "npm" && words[0] !== "npx") {
    return null;
  }
  return sussCommand(line) === null ? words : null;
}

/** Runs an install or a generator the page shows, so the suss commands after it see what a reader's project would have. */
function runSetup(words, cwd) {
  const result = spawnSync(words[0], words.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    return { output: String(result.error.message), status: null };
  }
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
}

function runSuss(args, cwd) {
  const result = spawnSync(process.execPath, [SUSS_BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  if (result.error !== undefined) {
    return { output: String(result.error.message), status: null };
  }

  // Both streams, in the order a terminal would have shown them.
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
}

/** Everything that moves between two runs of the same command. */
function normalize(text, project) {
  let normalized = text;
  for (const prefix of project.pathPrefixes) {
    normalized = normalized.split(`${prefix}/`).join("");
  }
  return normalized
    .replace(/\bin \d+(?:\.\d+)?s\b/g, "in Ns")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "Nms")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** The first few places two blocks of output part company. */
function firstDifferences(page, run, limit = 3) {
  const differences = [];
  for (let i = 0; i < Math.max(page.length, run.length); i++) {
    if (page[i] === run[i]) {
      continue;
    }
    differences.push({
      line: i + 1,
      page: page[i] ?? "(the page stops here)",
      run: run[i] ?? "(the run stops here)",
    });
    if (differences.length === limit) {
      break;
    }
  }
  return differences;
}

/** How a whole-output comparison went wrong, in one sentence. */
function mismatchSummary(page, run) {
  if (page.length !== run.length) {
    return `the page shows ${page.length} lines and the run printed ${run.length}`;
  }
  const differing = page.filter((line, i) => line !== run[i]).length;
  const lines = page.length === 1 ? "line" : "lines";
  return `${differing} of the ${page.length} ${lines} the page shows came back differently`;
}

/** Where the excerpt's lines best line up inside the whole output. A miss
 * still reports its best offset, so the failure points at the line that moved
 * rather than at the top of the run. */
function alignExcerpt(page, run) {
  let offset = 0;
  let matched = -1;

  for (let start = 0; start + page.length <= run.length; start++) {
    const here = page.filter((line, i) => line === run[start + i]).length;
    if (here > matched) {
      matched = here;
      offset = start;
    }
  }

  return { offset, whole: matched === page.length };
}

/** A directory of its own. `fixture=` copies one fixture in as the whole
 * project, and `fixtures=` copies each one in at the path it has in this
 * repository. */
function openProject(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-examples-"));
  const project = {
    dir,
    // A temporary directory is reached through a symlink on macOS, and the
    // CLI prints whichever of the two it resolved.
    pathPrefixes: [fs.realpathSync(dir), dir, ROOT],
    lastRun: null,
    keep: false,
    installs: options.has("install"),
  };

  const root = options.get("fixture");
  const named = options.get("fixtures");
  const copies = [
    ...(root === undefined ? [] : [{ name: root, to: dir }]),
    ...(named === undefined ? [] : named.split(",")).map((name) => ({
      name,
      to: path.join(dir, "fixtures", name),
    })),
  ];

  for (const { name, to } of copies) {
    const source = path.join(FIXTURES, name);
    if (!fs.existsSync(source)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { skip: `there is no fixture named ${name} to run it against` };
    }
    fs.cpSync(source, to, { recursive: true });
  }

  return { project };
}

function closeProject(project) {
  if (project === null || project.keep) {
    return;
  }
  fs.rmSync(project.dir, { recursive: true, force: true });
}

function parseOptions(rest) {
  const options = new Map();
  for (const word of rest.split(/\s+/).filter((word) => word !== "")) {
    const [key, value] = word.split("=");
    options.set(key, value ?? "");
  }
  return options;
}

function filePathFrom(paragraph) {
  if (paragraph === null) {
    return null;
  }
  const match = paragraph.lines.join(" ").match(FILE_INTRO);
  return match === null ? null : match[1];
}

function writeFileFence(fence, filePath, project) {
  if (filePath === null || project === null) {
    return;
  }
  const full = path.join(project.dir, filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${fence.body.join("\n")}\n`);
}

/** Run every suss command in one bash fence. The output a page shows below
 * such a fence is the last command's, which is how the pages are written.
 * On a page whose example says `install`, the npm and npx lines run too. */
function runBlock(file, fence, project) {
  let last = null;
  for (const line of fence.body) {
    const setup = project.installs ? packageCommand(line) : null;
    if (setup !== null) {
      const run = runSetup(setup, project.dir);
      if (run.status !== 0) {
        project.keep = true;
        record(file, fence.line, "failed", {
          command: line.trim(),
          summary: `it exited ${run.status}: ${run.output.trim().split("\n").at(-1)}`,
          kept: project.dir,
        });
      }
      continue;
    }

    const args = sussCommand(line);
    if (args === null) {
      continue;
    }
    last = { command: line.trim(), ...runSuss(args, project.dir) };
  }
  if (last !== null) {
    project.lastRun = last;
  }
  return last;
}

const results = [];

function record(file, line, state, detail) {
  results.push({ file: path.relative(ROOT, file), line, state, detail });
}

function compare(file, fence, run, excerpt, project) {
  const page = normalize(fence.body.join("\n"), project).split("\n");
  const whole = normalize(run.output, project).split("\n");
  const alignment = excerpt ? alignExcerpt(page, whole) : { offset: 0 };
  const actual = excerpt
    ? whole.slice(alignment.offset, alignment.offset + page.length)
    : whole;
  const agreed = excerpt
    ? alignment.whole
    : page.join("\n") === actual.join("\n");

  if (agreed) {
    record(file, fence.line, "checked", { command: run.command });
    return;
  }

  // A failing run stays on disk so somebody can go and look at it.
  project.keep = true;
  record(file, fence.line, "failed", {
    command: run.command,
    summary: excerpt
      ? `the page shows these lines as part of the output, and the closest the run came is at its line ${alignment.offset + 1}`
      : mismatchSummary(page, actual),
    differences: firstDifferences(page, actual),
    kept: project.dir,
  });
}

const FLAG = /(?<![\w-])(--?[a-z][\w-]*)/g;

const USAGE_LINE = /^\s+suss (\w[\w-]*)(.*)$/;

const OPTIONS_HEADER = /^Options \((\w+)/;

/** Flags the CLI takes with any command, or with none. */
const GLOBAL_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

/** For each command, the flags `suss --help` lists in its usage lines and
 * under its options. */
function flagsByCommand() {
  const byCommand = new Map();
  const add = (command, text) => {
    const flags = byCommand.get(command) ?? new Set();
    for (const match of text.matchAll(FLAG)) {
      flags.add(match[1]);
    }
    byCommand.set(command, flags);
  };

  let section = null;
  for (const line of runSuss(["--help"], ROOT).output.split("\n")) {
    const usage = line.match(USAGE_LINE);
    if (usage !== null) {
      add(usage[1], usage[2]);
      continue;
    }

    const header = line.match(OPTIONS_HEADER);
    if (header !== null || /^\S/.test(line)) {
      section = header?.[1] ?? null;
      continue;
    }

    if (section !== null) {
      add(section, line);
    }
  }
  return byCommand;
}

let helpFlags = null;

function knownFlags() {
  helpFlags ??= flagsByCommand();
  return helpFlags;
}

/** Why the CLI would not take these arguments, or null when `suss --help`
 * lists the command and every flag on it. */
function flagProblem(args) {
  const flagsFor = knownFlags();
  const first = args[0];
  const command = first !== undefined && !first.startsWith("-") ? first : null;
  if (command !== null && !flagsFor.has(command)) {
    return `suss --help lists no ${command} command`;
  }

  const known = command === null ? new Set() : flagsFor.get(command);
  const unknown = args
    .filter((arg) => /^--?[a-z]/i.test(arg))
    .map((arg) => arg.split("=")[0])
    .filter((flag) => !GLOBAL_FLAGS.has(flag) && !known.has(flag));
  if (unknown.length === 0) {
    return null;
  }

  const where = command === null ? "suss itself" : `suss ${command}`;
  return `suss --help lists no ${unknown.join(", ")} for ${where}`;
}

/** Each distinct suss command in the inline code of some prompts. One
 * spelled with npx is one the agent runs; a bare `suss ...` is a mention. */
function promptCommands(fences) {
  const commands = new Map();
  for (const line of fences.flatMap((fence) => fence.body)) {
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      for (const text of span[1]
        .split(/&&|\|\||;/)
        .map((part) => part.trim())) {
        const args = sussCommand(text);
        if (args !== null && !commands.has(text)) {
          commands.set(text, { text, args, runs: text.startsWith("npx ") });
        }
      }
    }
  }
  return [...commands.values()];
}

const prompts = [];

const promptFailures = [];

function recordPromptFailure(file, line, detail) {
  promptFailures.push({
    file: path.relative(ROOT, file),
    line,
    state: "failed",
    detail,
  });
}

/**
 * Check the suss commands a group of prompts gives an agent. Every flag has
 * to be one `suss --help` lists for its command, and every command the agent
 * runs has to exit 0 in the fixture the page gives the prompts.
 */
function checkPrompts(file, group) {
  const commands = promptCommands(group.fences);
  for (const command of commands) {
    const problem = flagProblem(command.args);
    if (problem !== null) {
      recordPromptFailure(file, group.line, {
        command: command.text,
        summary: problem,
      });
      continue;
    }

    if (!command.runs) {
      continue;
    }

    const run = runSuss(command.args, group.project.dir);
    if (run.status !== 0) {
      group.project.keep = true;
      recordPromptFailure(file, group.line, {
        command: command.text,
        summary: `it exited ${run.status}: ${run.output.trim().split("\n")[0]}`,
        kept: group.project.dir,
      });
    }
  }

  prompts.push({ fences: group.fences.length, commands: commands.length });
  closeProject(group.project);
}

/**
 * Walk one page top to bottom: write the files it states, run the suss
 * commands it shows, and compare each output fence against the run above it.
 */
function checkPage(file) {
  const items = itemsOf(pageLines(file));
  const pairs = pairingsIn(items);
  const runs = new Map();

  let project = null;
  let stopped = null;
  let pendingPath = null;
  let pendingExcerpt = false;
  let previous = null;
  let prompt = null;

  const finishPrompt = () => {
    if (prompt !== null) {
      checkPrompts(file, prompt);
      prompt = null;
    }
  };

  const notes = {
    example: (note) => {
      const opened = openProject(parseOptions(note.rest));
      project = opened.project ?? null;
      stopped = opened.skip ?? null;
    },
    prompt: (note) => {
      const opened = openProject(parseOptions(note.rest));
      if (opened.skip !== undefined) {
        recordPromptFailure(file, note.line, { summary: opened.skip });
        return;
      }
      prompt = { line: note.line, project: opened.project, fences: [] };
    },
    file: (note) => {
      pendingPath = note.rest;
    },
    excerpt: () => {
      pendingExcerpt = true;
    },
    unchecked: (note) => {
      closeProject(project);
      project = null;
      stopped = note.rest;
    },
  };

  const whyUnchecked = () => {
    if (stopped !== null) {
      return stopped;
    }
    return "nobody has said what project it runs in";
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];

    if (item.type === "note") {
      finishPrompt();
      const handler = notes[item.name];
      if (handler === undefined) {
        record(file, item.line, "failed", {
          summary: `suss:${item.name} is not an annotation this check knows`,
        });
        continue;
      }
      handler(item);
      continue;
    }

    if (item.type === "paragraph") {
      if (item.lines[0].startsWith("#")) {
        finishPrompt();
      }
      previous = item;
      continue;
    }

    if (prompt !== null) {
      prompt.fences.push(item);
      continue;
    }

    const introduced = pendingPath;
    const excerpt = pendingExcerpt;
    pendingPath = null;
    pendingExcerpt = false;

    if (item.lang === "bash") {
      if (project !== null) {
        runs.set(index, runBlock(file, item, project));
      }
      previous = null;
      continue;
    }

    if (item.lang !== "") {
      writeFileFence(item, introduced ?? filePathFrom(previous), project);
      previous = null;
      continue;
    }

    previous = null;
    const partner = pairs.get(index);
    if (partner === undefined && !excerpt) {
      continue;
    }

    if (project === null) {
      record(file, item.line, "skipped", { summary: whyUnchecked() });
      continue;
    }

    const run = partner === undefined ? project.lastRun : runs.get(partner);
    if (run === null || run === undefined) {
      record(file, item.line, "skipped", {
        summary: "no suss command runs above it",
      });
      continue;
    }

    compare(file, item, run, excerpt, project);
  }

  finishPrompt();
  closeProject(project);
}

if (!fs.existsSync(SUSS_BIN)) {
  process.stderr.write(
    "The CLI has not been built, so there is nothing to run the documented commands with.\nRun npm run build first.\n",
  );
  process.exit(1);
}

for (const file of [...markdownFiles(DOCS)].sort()) {
  checkPage(file);
}

const failedBlocks = results.filter((result) => result.state === "failed");
const failed = [...failedBlocks, ...promptFailures];
const checked = results.filter((result) => result.state === "checked");
const skipped = results.filter((result) => result.state === "skipped");

for (const result of failed) {
  process.stderr.write(`${result.file}:${result.line}\n`);
  if (result.detail.command !== undefined) {
    process.stderr.write(`  ${result.detail.command}\n`);
  }
  process.stderr.write(`  ${result.detail.summary}\n`);
  for (const difference of result.detail.differences ?? []) {
    process.stderr.write(`\n  line ${difference.line}\n`);
    process.stderr.write(`    page: ${difference.page}\n`);
    process.stderr.write(`    run:  ${difference.run}\n`);
  }
  if (result.detail.kept !== undefined) {
    process.stderr.write(`\n  the run is still at ${result.detail.kept}\n`);
  }
  process.stderr.write("\n");
}

const stream = failed.length === 0 ? process.stdout : process.stderr;

stream.write(
  `Ran ${checked.length} of the ${results.length} output blocks in docs/ and compared what came back.\n`,
);

const promptCount = prompts.reduce((sum, group) => sum + group.fences, 0);
const promptCommandCount = prompts.reduce(
  (sum, group) => sum + group.commands,
  0,
);

stream.write(
  `Looked up the ${promptCommandCount} suss commands in ${promptCount} agent prompts in suss --help, and ran each one an agent runs.\n`,
);

if (skipped.length > 0) {
  stream.write("\nNot checked:\n");
  for (const result of skipped) {
    stream.write(`  ${result.file}:${result.line}  ${result.detail.summary}\n`);
  }
  stream.write(
    "\nAn unchecked block can say anything. That list is the part of the\ndocumentation nobody is watching.\n",
  );
}

if (failedBlocks.length > 0) {
  stream.write(
    `\n${failedBlocks.length} ${failedBlocks.length === 1 ? "block does" : "blocks do"} not match what the command printed.\n`,
  );
}

if (promptFailures.length > 0) {
  stream.write(
    `\n${promptFailures.length} ${promptFailures.length === 1 ? "command" : "commands"} in the agent prompts would fail for an agent that copied them.\n`,
  );
}

if (failed.length > 0) {
  process.exit(1);
}
