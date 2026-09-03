/**
 * project.ts: the summaries for one project, kept current while the
 * server runs.
 *
 * The CLI extracts to files and later reads them back, which is right
 * for a command that runs once. A server answers many questions over
 * one working tree, and an answer computed from an extract taken ten
 * minutes ago is worse than no answer, because the code it describes is
 * the code somebody has since changed.
 *
 * So this owns a directory of summaries, re-runs the commands
 * `suss.json` says when a source file changes, and hands out the path
 * every question reads from. Re-extracting is cheap after the first
 * run: `suss extract` keeps a per-file cache keyed on content, so an
 * edit to one file rebuilds one file's worth of work.
 *
 * The debounce exists because an agent writing code produces bursts of
 * writes, and re-extracting on each one would spend the whole burst
 * rebuilding work the next write throws away.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  contract,
  extract,
  loadedSummaries,
  readSummariesFromDir,
} from "@suss/cli";

import type { ContractSource, Language, LoadedSummaries } from "@suss/cli";

/** How long the writes have to stop before a rebuild starts. */
const DEFAULT_SETTLE_MS = 400;

/** What `suss.json` says this project contains. */
interface ProjectFile {
  version: 1;
  read: Array<
    | { kind: "extract"; language: string; project?: string; packs: string[] }
    | { kind: "contract"; from: string; file: string }
  >;
}

export interface ProjectOptions {
  /** The project root, which is where `suss.json` is looked for. */
  root: string;
  /** Where to put the summaries. A temporary directory by default. */
  summaryDir?: string;
  /** Watch the tree and rebuild on a change. On by default. */
  watch?: boolean;
  /**
   * How long writes have to stop before a rebuild starts. The default
   * suits an editor. A test that waits on a rebuild sets it low, so
   * what the test covers stops depending on scheduler timing.
   */
  settleMs?: number;
}

/** What a rebuild produced, so a caller can say why an answer is thin. */
export interface BuildReport {
  summaryDir: string;
  /** One line per command that ran, and what it wrote or why it did not. */
  ran: string[];
  /** Commands `suss.json` asked for that threw. */
  failed: string[];
  /** Null when the project has no `suss.json`. */
  configured: boolean;
}

export class Project {
  readonly root: string;
  readonly summaryDir: string;

  private config: ProjectFile | null = null;
  private report: BuildReport;
  private watcher: fs.FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;
  private watchWanted = true;
  private readonly settleMs: number;
  private readonly ownsSummaryDir: boolean;
  /** A rebuild already running, so a burst does not start a second. */
  private running: Promise<BuildReport> | null = null;
  /** The summary directory as last read, dropped when a build rewrites it. */
  private loaded: LoadedSummaries | null = null;
  /** Whether a build has ever finished, so lastBuild() is known to describe the project rather than the placeholder set before the first one. */
  private everBuilt = false;

  constructor(options: ProjectOptions) {
    // Resolved through any symlink, because a recursive watch reports
    // the paths the operating system knows, and those are the resolved
    // ones. Watching the link and comparing against the link's own name
    // misses every event.
    this.root = realPath(path.resolve(options.root));
    this.summaryDir =
      options.summaryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "suss-mcp-"));
    // Only a directory this made is a directory this may remove. One
    // the caller chose is theirs, and they may want to read it after.
    this.ownsSummaryDir = options.summaryDir === undefined;
    fs.mkdirSync(this.summaryDir, { recursive: true });
    this.report = {
      summaryDir: this.summaryDir,
      ran: [],
      failed: [],
      configured: false,
    };
    this.watchWanted = options.watch !== false;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  }

  /**
   * Read the project and run what it says. Split out of the
   * constructor because both commands it runs are async.
   *
   * Kicks the build off and returns before it finishes, so a caller can
   * open its transport while the first extract still runs. A question
   * asked in that window waits on settled() instead of blocking startup.
   *
   * The watcher is armed once that build finishes rather than
   * alongside it, because a filesystem watch armed moments after a
   * project's own files are written can echo those same writes back as
   * change events and rebuild for no reason.
   */
  start(): Promise<BuildReport> {
    const build = this.runBuild();
    this.running = build.finally(() => {
      this.running = null;
    });
    if (this.watchWanted) {
      void build.then(() => this.watch());
    }
    return build;
  }

  /** The last build, so a tool can say where its answer came from. */
  lastBuild(): BuildReport {
    return this.report;
  }

  /** Whether the first build or a watch-triggered rebuild is still running. */
  building(): boolean {
    return this.running !== null;
  }

  /** Whether a build has ever finished, so a caller can tell the placeholder before the first one apart from a project that has no suss.json. */
  hasBuilt(): boolean {
    return this.everBuilt;
  }

  /** Wait for a build in flight, whether the first one or a rebuild, so a question reads a settled directory. */
  async settled(): Promise<void> {
    await this.running;
  }

  /**
   * The summaries in the directory, read once and kept until a build
   * writes new ones.
   *
   * Reading and parsing the directory is most of what a question costs
   * on a large project, and an agent asks many questions between edits.
   */
  summaries(): LoadedSummaries {
    this.loaded ??= loadedSummaries(readSummariesFromDir(this.summaryDir));
    return this.loaded;
  }

  /**
   * Run everything `suss.json` says, into the summary directory.
   *
   * A command that throws takes down its own entry and nothing else. A
   * project with one unreadable spec should still answer questions
   * about the code suss could read.
   */
  async build(): Promise<BuildReport> {
    this.config = readProjectFile(this.root);
    const ran: string[] = [];
    const failed: string[] = [];

    if (this.config === null) {
      this.loaded = null;
      this.everBuilt = true;
      this.report = {
        summaryDir: this.summaryDir,
        ran,
        failed,
        configured: false,
      };
      return this.report;
    }

    for (const [index, entry] of this.config.read.entries()) {
      const out = path.join(this.summaryDir, `${index}-${entry.kind}.json`);
      try {
        await runEntry(entry, this.root, out);
        ran.push(describeEntry(entry));
      } catch (error) {
        failed.push(`${describeEntry(entry)}: ${messageOf(error)}`);
      }
    }

    // Dropped after the writes rather than before, so a question asked
    // during a build cannot leave a half-written directory cached.
    this.loaded = null;
    this.everBuilt = true;
    this.report = {
      summaryDir: this.summaryDir,
      ran,
      failed,
      configured: true,
    };
    return this.report;
  }

  /**
   * Run a build and never let it reject.
   *
   * Every command build() runs is already caught per entry, so this
   * only guards against something outside that, such as the project
   * file read. A rejection here would leave settled() waiting on a
   * promise nobody catches, which is worse than reporting the failure.
   */
  private async runBuild(): Promise<BuildReport> {
    try {
      return await this.build();
    } catch (error) {
      this.loaded = null;
      this.everBuilt = true;
      this.report = {
        summaryDir: this.summaryDir,
        ran: [],
        failed: [messageOf(error)],
        configured: this.report.configured,
      };
      return this.report;
    }
  }

  /**
   * Stop watching and clear up. A server shutting down calls this.
   *
   * The summaries go with it when this made the directory they are in,
   * since a server that ran for a week and stopped should not leave one
   * behind.
   */
  close(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    this.watcher?.close();
    this.watcher = null;
    if (this.ownsSummaryDir) {
      fs.rmSync(this.summaryDir, { recursive: true, force: true });
    }
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(
        this.root,
        { recursive: true },
        (_event, filename) => {
          if (filename !== null && worthRebuilding(filename)) {
            this.rebuildSoon();
          }
        },
      );
    } catch {
      // A platform without recursive watch answers from whatever the
      // first build produced. Stale is better than refusing to start.
      this.watcher = null;
    }
  }

  private rebuildSoon(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      this.running = this.runBuild().finally(() => {
        this.running = null;
      });
    }, this.settleMs);
    this.pending.unref?.();
  }
}

/** The path with symlinks followed, or the path itself when it has none. */
function realPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function readProjectFile(root: string): ProjectFile | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, "suss.json"), "utf8"),
    ) as ProjectFile;
    return Array.isArray(parsed?.read) ? parsed : null;
  } catch {
    return null;
  }
}

async function runEntry(
  entry: ProjectFile["read"][number],
  root: string,
  out: string,
): Promise<void> {
  if (entry.kind === "contract") {
    await contract({
      from: entry.from as ContractSource,
      spec: path.resolve(root, entry.file),
      output: out,
    });
    return;
  }
  await extract({
    dir: root,
    frameworks: entry.packs,
    output: out,
    lang: entry.language as Language,
    ...(entry.project !== undefined
      ? { tsconfig: path.resolve(root, entry.project) }
      : {}),
  });
}

function describeEntry(entry: ProjectFile["read"][number]): string {
  return entry.kind === "contract"
    ? `contract --from ${entry.from} ${entry.file}`
    : `extract --lang ${entry.language} ${entry.packs.map((p) => `-f ${p}`).join(" ")}`;
}

/**
 * Whether a changed file is one a rebuild would read differently.
 *
 * Everything under a build output or a package directory changes
 * constantly and changes nothing about what the code does, so a watcher
 * that rebuilds on those never stops rebuilding.
 *
 * Exported because what the operating system reports to a recursive
 * watcher differs by platform, so the only way to test this is to
 * pass it the paths directly.
 */
export function worthRebuilding(filename: string): boolean {
  const parts = filename.split(path.sep);
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) {
    return false;
  }
  return WATCHED_EXTENSIONS.has(path.extname(filename));
}

// ".suss" is where a build writes its own extraction cache, so a
// rebuild would otherwise keep triggering itself.
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".next",
  ".turbo",
  "build",
  ".suss",
]);

const WATCHED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
