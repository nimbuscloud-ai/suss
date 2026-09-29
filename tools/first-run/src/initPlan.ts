/**
 * Turns what `suss init --write` printed into the commands a newcomer
 * would run next.
 *
 * At a monorepo root, init prints one section per project under a
 * `════ <dir> ════` heading, with commands relative to that project, and
 * every section writes `summaries/code.json`. The plan runs each command
 * in its project and sends every output to one shared folder, so one
 * `check --dir` sees both sides of a boundary.
 *
 * The install line and init's own `check` are dropped: the harness runs
 * the CLI under test and its own `check` over the shared folder.
 */

import path from "node:path";

export interface InitProject {
  /** Relative to the directory init ran in; "." for a single project. */
  dir: string;
  commands: string[][];
  /** Lines init printed about a pack it left out and what to write for it. */
  notes: string[];
  /** Pack config files init told the user to write, with the example it printed. */
  configs: PackConfig[];
}

export interface PackConfig {
  file: string;
  contents: string;
}

export interface PlannedCommand {
  project: string;
  cwd: string;
  argv: string[];
  output: string;
  /** Only extract is re-run at the parent commit, the way the PR comment does. */
  verb: string;
}

const SECTION_HEADING = /^═+ (.+?) ═+$/;
// Prose that starts with "suss" is indented two spaces, commands three.
const COMMAND_LINE = /^ {3}suss\s+((?:extract|contract)\b.*)$/;
// init prints a command ending in "..." when a pack is still missing from it.
const UNFINISHED = /\s\.\.\.$/;
const NOTE_LINE = /reads nothing until|Write that to|leaves? .* out/;
const WRITE_CONFIG = /Write that to (\S+):\s*$/;

export function parseInitOutput(text: string): InitProject[] {
  const projects: InitProject[] = [];
  let current = emptyProject(".");
  let pendingConfig: string | undefined;
  for (const line of text.split("\n")) {
    const heading = SECTION_HEADING.exec(line.trim());
    if (heading !== null && heading[1] !== undefined) {
      pushIfUsed(projects, current);
      current = emptyProject(heading[1]);
      continue;
    }

    if (pendingConfig !== undefined && line.trim().startsWith("{")) {
      current.configs.push({ file: pendingConfig, contents: line.trim() });
      pendingConfig = undefined;
      continue;
    }

    pendingConfig = WRITE_CONFIG.exec(line)?.[1] ?? pendingConfig;

    const command = COMMAND_LINE.exec(line);
    if (command !== null && command[1] !== undefined) {
      const printed = command[1].trim();
      if (UNFINISHED.test(printed)) {
        current.notes.push(`unfinished command: suss ${printed}`);
      } else {
        current.commands.push(printed.split(/\s+/));
      }

      continue;
    }

    if (NOTE_LINE.test(line)) {
      current.notes.push(line.trim());
    }
  }

  pushIfUsed(projects, current);
  return projects;
}

function emptyProject(dir: string): InitProject {
  return { dir, commands: [], notes: [], configs: [] };
}

function pushIfUsed(projects: InitProject[], project: InitProject): void {
  if (project.commands.length > 0 || project.notes.length > 0) {
    projects.push(project);
  }
}

export function planCommands(
  projects: InitProject[],
  root: string,
  outDir: string,
): PlannedCommand[] {
  const planned: PlannedCommand[] = [];
  for (const project of projects) {
    const cwd = path.resolve(root, project.dir);
    const slug = projectSlug(project.dir);
    for (const argv of project.commands) {
      const verb = argv[0] ?? "";
      const { rewritten, output } = redirectOutput(argv, outDir, slug);
      planned.push({
        project: project.dir,
        cwd,
        argv: rewritten,
        output,
        verb,
      });
    }
  }

  return planned;
}

export function projectSlug(dir: string): string {
  if (dir === ".") {
    return "root";
  }

  return dir.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function redirectOutput(
  argv: string[],
  outDir: string,
  slug: string,
): { rewritten: string[]; output: string } {
  const flagAt = argv.findIndex((arg) => arg === "-o" || arg === "--output");
  const printed = flagAt >= 0 ? argv[flagAt + 1] : undefined;
  const base =
    printed === undefined ? `${argv[0]}.json` : path.basename(printed);
  const output = path.join(outDir, `${slug}--${base}`);
  if (flagAt < 0 || printed === undefined) {
    return { rewritten: [...argv, "-o", output], output };
  }

  const rewritten = [...argv];
  rewritten[flagAt + 1] = output;
  return { rewritten, output };
}
