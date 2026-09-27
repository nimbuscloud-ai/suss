/**
 * The summaries for one project, kept current while the server runs.
 *
 * The CLI extracts to files and reads them back later, which suits a
 * command that runs once. A server gets many questions about one
 * working tree while somebody edits it, and an answer from a stale
 * extract describes code that has since changed.
 *
 * So a `Project` keeps its own summary directory and re-runs the
 * commands in `suss.json` when a source file changes, keeping each
 * command's adapter so a run after an edit parses only what changed.
 * Rebuilds are debounced, since an agent writes files in bursts. The
 * package README says what stays in memory and for how long.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearEarlierReads,
  declaredReads,
  KeptAdapters,
  loadedSummaries,
  readProjectInto,
  readSummariesFromDir,
} from "@suss/cli";

import type { LoadedSummaries } from "@suss/cli";

/** How long the writes have to stop before a rebuild starts. */
const DEFAULT_SETTLE_MS = 400;

/**
 * How long the server keeps the programs it built with nothing asking
 * for a build. A large TypeScript program takes several gigabytes, and a
 * build after the programs were let go costs what a CLI run with a warm
 * cache costs.
 */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

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
  /** How long to keep the built programs with no build asked for. */
  idleMs?: number;
}

/** What a rebuild produced, so a caller can say why an answer is thin. */
export interface BuildReport {
  summaryDir: string;
  /** One line per command that ran, and what it wrote or why it did not. */
  ran: string[];
  /** Commands `suss.json` asked for that threw. */
  failed: string[];
  /** Extract commands that ran and wrote no summary. */
  empty: string[];
  /** False when the project has no `suss.json`, so detection picked the reads. */
  configured: boolean;
}

/**
 * Another server's build, for a server that is not the one keeping the
 * programs. Null when that server could not be reached, and this one
 * builds for itself.
 */
export type BuildElsewhere = (
  summaryDir: string,
) => Promise<BuildReport | null>;

export class Project {
  readonly root: string;
  readonly summaryDir: string;

  private report: BuildReport;
  private watcher: fs.FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;
  private watchWanted = true;
  private readonly settleMs: number;
  private readonly idleMs: number;
  private readonly ownsSummaryDir: boolean;
  /** The adapters each read of `suss.json` left, for the next read. */
  private readonly kept = new KeptAdapters();
  /** Builds run one after another, each after the last has finished. */
  private chain: Promise<unknown> = Promise.resolve();
  /** A build that is queued and has not started, which a new ask joins. */
  private queued: Promise<BuildReport> | null = null;
  /** The build running now, and when it started reading the tree. */
  private started: { at: number; build: Promise<BuildReport> } | null = null;
  /** When the last finished build started reading the tree. */
  private lastStart: number | null = null;
  private inFlight = 0;
  /** Work the kept adapters do between builds, which the next build waits on. */
  private preparing: Promise<void> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private elsewhere: BuildElsewhere | null = null;
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
      empty: [],
      configured: false,
    };
    this.watchWanted = options.watch !== false;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
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
    const build = this.scheduleBuild();
    if (this.watchWanted) {
      void build.then(() => this.watch());
    }
    return build;
  }

  /**
   * A build that read the tree after `notBefore`, for a caller that
   * knows the tree changed and cannot wait out the debounce, such as a
   * hook that runs right after an edit. A build that started after
   * `notBefore` read every file after that moment, so it is reused, the
   * one the watcher started included. Otherwise a new build starts after
   * any build already running. Without `notBefore`, it always builds.
   */
  buildNow(notBefore?: number): Promise<BuildReport> {
    const covering =
      notBefore === undefined ? null : this.buildStartedSince(notBefore);
    if (covering !== null) {
      return covering;
    }
    this.cancelPending();
    return this.scheduleBuild();
  }

  private buildStartedSince(notBefore: number): Promise<BuildReport> | null {
    if (this.queued !== null) {
      return this.queued;
    }
    // Both are whole milliseconds, so a build stamped with the same one
    // may have started a moment before the change.
    if (this.started !== null) {
      return this.started.at > notBefore ? this.started.build : null;
    }
    const last = this.lastStart;
    return last !== null && last > notBefore && this.everBuilt
      ? Promise.resolve(this.report)
      : null;
  }

  /**
   * Delays every build until `ready` settles, for a caller that first
   * has to find out whether another server builds for this one.
   */
  delayBuildsUntil(ready: Promise<unknown>): void {
    this.preparing = ready.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Hands builds to another server that keeps the programs, or takes
   * them back with null. See `BuildElsewhere`.
   */
  buildElsewhere(elsewhere: BuildElsewhere | null): void {
    this.elsewhere = elsewhere;
    if (elsewhere !== null) {
      this.kept.release();
    }
  }

  /** The last build, so a tool can say where its answer came from. */
  lastBuild(): BuildReport {
    return this.report;
  }

  /** Whether the first build or a later rebuild is still running. */
  building(): boolean {
    return this.inFlight > 0;
  }

  /**
   * Whether a build has ever finished. Before the first one, lastBuild()
   * looks the same as a project with no suss.json.
   */
  hasBuilt(): boolean {
    return this.everBuilt;
  }

  /** How many adapters this server keeps between builds. */
  keptAdapters(): number {
    return this.kept.size;
  }

  /** Waits for any build in flight, so a question reads a settled directory. */
  async settled(): Promise<void> {
    await this.chain;
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
    const remote = await this.elsewhere?.(this.summaryDir);
    if (remote !== undefined && remote !== null) {
      return this.finished({ ...remote, summaryDir: this.summaryDir });
    }

    const reads = await declaredReads(this.root);
    // An entry that fails this time must not leave last time's summaries.
    clearEarlierReads(this.summaryDir);
    const { ran, failed, empty } = await readProjectInto(
      this.root,
      this.summaryDir,
      reads,
      this.kept,
    );
    return this.finished({
      summaryDir: this.summaryDir,
      ran,
      failed,
      empty,
      configured: reads.declared,
    });
  }

  /**
   * Dropped after the writes rather than before, so a question asked
   * during a build cannot leave a half-written directory cached.
   */
  private finished(report: BuildReport): BuildReport {
    this.loaded = null;
    this.everBuilt = true;
    this.report = report;
    return report;
  }

  /**
   * Stop watching and clear up. A server shutting down calls this.
   *
   * The summaries go with it when this made the directory they are in,
   * since a server that ran for a week and stopped should not leave one
   * behind.
   */
  close(): void {
    this.cancelPending();
    if (this.idle !== null) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.kept.release();
    if (this.ownsSummaryDir) {
      fs.rmSync(this.summaryDir, { recursive: true, force: true });
    }
  }

  /**
   * Queues a build behind the one running. A caller that asks while a
   * build is queued and not yet started joins that build, since it has
   * not read the tree yet either.
   */
  private scheduleBuild(): Promise<BuildReport> {
    if (this.queued !== null) {
      return this.queued;
    }
    this.inFlight += 1;
    const build: Promise<BuildReport> = this.chain
      .then(async () => {
        this.queued = null;
        await this.preparing;
        const at = Date.now();
        this.started = { at, build };
        const report = await this.runBuild();
        this.started = null;
        this.lastStart = at;
        return report;
      })
      .finally(() => {
        this.inFlight -= 1;
      });
    this.queued = build;
    this.chain = build.catch(() => undefined);
    return build;
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
    let report: BuildReport;
    try {
      report = await this.build();
    } catch (error) {
      report = this.finished({
        summaryDir: this.summaryDir,
        ran: [],
        failed: [messageOf(error)],
        empty: [],
        configured: this.report.configured,
      });
    }
    this.afterBuild();
    return report;
  }

  /**
   * A build served whole from the cache loads no program, so the kept
   * adapters load theirs now, before the edit that needs one. The next
   * build waits for that, and questions do not.
   */
  private afterBuild(): void {
    this.preparing = this.kept.prepare().catch(() => undefined);
    if (this.idle !== null) {
      clearTimeout(this.idle);
    }
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.building()) {
        this.kept.release();
      }
    }, this.idleMs);
    this.idle.unref?.();
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(
        this.root,
        { recursive: true },
        (_event, filename) => {
          if (filename !== null && worthRebuilding(filename)) {
            this.kept.noteChanged([path.join(this.root, filename)]);
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
    this.cancelPending();
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.scheduleBuild();
    }, this.settleMs);
    this.pending.unref?.();
  }

  private cancelPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
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
