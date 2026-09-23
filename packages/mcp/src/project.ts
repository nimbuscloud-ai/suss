/**
 * The summaries for one project, kept current while the server runs.
 *
 * The CLI extracts to files and reads them back later, which suits a
 * command that runs once. A server gets many questions about one
 * working tree while somebody edits it, and an answer from a stale
 * extract describes code that has since changed.
 *
 * So a `Project` keeps its own summary directory and re-runs the
 * commands in `suss.json` when a source file changes. After the first
 * run this is cheap, because `suss extract` caches per file by content.
 * Rebuilds are debounced, since an agent writes files in bursts and a
 * rebuild per write would be thrown away by the next one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  declaredReads,
  loadedSummaries,
  readProjectInto,
  readSummariesFromDir,
} from "@suss/cli";

import type { LoadedSummaries } from "@suss/cli";

/** How long the writes have to stop before a rebuild starts. */
const DEFAULT_SETTLE_MS = 400;

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
  /** False when the project has no `suss.json`, so detection picked the reads. */
  configured: boolean;
}

export class Project {
  readonly root: string;
  readonly summaryDir: string;

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
  /** Set once a build finishes. Before that, lastBuild() is a placeholder. */
  private everBuilt = false;

  constructor(options: ProjectOptions) {
    // A recursive watch reports resolved paths, so a root compared by
    // its symlinked name would miss every event.
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

  /**
   * Whether a build has ever finished. Before the first one, lastBuild()
   * looks the same as a project with no suss.json.
   */
  hasBuilt(): boolean {
    return this.everBuilt;
  }

  /** Waits for any build in flight, so a question reads a settled directory. */
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
    const reads = await declaredReads(this.root);
    const { ran, failed } = await readProjectInto(
      this.root,
      this.summaryDir,
      reads,
    );

    // Dropped after the writes rather than before, so a question asked
    // during a build cannot leave a half-written directory cached.
    this.loaded = null;
    this.everBuilt = true;
    this.report = {
      summaryDir: this.summaryDir,
      ran,
      failed,
      configured: reads.declared,
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
      // Without recursive watch, questions read what the first build
      // produced. Stale summaries beat a server that refuses to start.
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
