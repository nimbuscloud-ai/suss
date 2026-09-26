/**
 * The session record: everything the hooks and the worker share for one
 * Claude Code session, kept in `.suss/session/<session id>/` under the
 * project. The README lists the files in it.
 *
 * Hooks are short-lived processes and the worker outlives them, so they
 * talk only through these files. A file another process may read while
 * it is being written goes to a temporary name first and is renamed
 * into place.
 */

import fs from "node:fs";
import path from "node:path";

/** @typedef {import("./types.js").EditRequest} EditRequest */
/** @typedef {import("./types.js").EditResult} EditResult */
/** @typedef {import("./types.js").SnapshotMeta} SnapshotMeta */
/** @typedef {import("./types.js").StopRecord} StopRecord */
/** @typedef {"baseline" | "current" | "next"} Snapshot */

export class Session {
  /**
   * @param {string} projectDir
   * @param {string} sessionId
   */
  constructor(projectDir, sessionId) {
    this.projectDir = projectDir;
    this.id = sessionId;
    this.dir = path.join(
      projectDir,
      ".suss",
      "session",
      sessionId.replace(/[^\w.-]/g, "_"),
    );
  }

  /** @param {string} name */
  file(name) {
    return path.join(this.dir, name);
  }

  exists() {
    return fs.existsSync(this.dir);
  }

  /** Creates the record, and keeps `.suss/session` out of version control. */
  create() {
    fs.mkdirSync(path.join(this.dir, "state"), { recursive: true });
    const ignore = path.join(path.dirname(this.dir), ".gitignore");
    if (!fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, "*\n");
    }
  }

  /** @param {string} prompt */
  appendPrompt(prompt) {
    appendLine(this.file("prompts.jsonl"), {
      at: new Date().toISOString(),
      prompt,
    });
  }

  /**
   * Queues an edit and returns its place in the queue. The worker has
   * read the edit once `processed()` reaches that number.
   *
   * @param {Omit<EditRequest, "at">} request
   */
  appendEdit(request) {
    appendLine(this.file("edits.jsonl"), {
      at: new Date().toISOString(),
      ...request,
    });
    return this.editCount();
  }

  editCount() {
    return readLines(this.file("edits.jsonl")).length;
  }

  processed() {
    return readJson(this.file("progress.json"), { processed: 0 }).processed;
  }

  /** @param {number} count */
  setProcessed(count) {
    writeJson(this.file("progress.json"), { processed: count });
  }

  /** Whether the worker has anything left to do. */
  hasWork() {
    if (this.ended() || this.disabledReason() !== null) {
      return false;
    }
    return !this.hasSnapshot("baseline") || this.processed() < this.editCount();
  }

  /** @param {Snapshot} name */
  snapshotDir(name) {
    return path.join(this.dir, "state", name);
  }

  /** @param {Snapshot} name */
  hasSnapshot(name) {
    return fs.existsSync(this.metaFile(name));
  }

  /**
   * @param {Snapshot} name
   * @returns {SnapshotMeta | null}
   */
  snapshotMeta(name) {
    return readJson(this.metaFile(name), null);
  }

  /**
   * The summary files in a snapshot, sorted by name.
   *
   * @param {Snapshot} name
   */
  snapshotFiles(name) {
    const dir = this.snapshotDir(name);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  }

  /** An empty `next` snapshot for the worker to extract into. */
  freshNext() {
    const dir = this.snapshotDir("next");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Makes `from` the new `to`. The metadata is written last, so a reader
   * that finds it also finds the summaries.
   *
   * @param {Snapshot} from
   * @param {Snapshot} to
   * @param {SnapshotMeta} meta
   * @param {{ copy?: boolean }} [options]
   */
  promote(from, to, meta, options = {}) {
    const target = this.snapshotDir(to);
    fs.rmSync(this.metaFile(to), { force: true });
    fs.rmSync(target, { recursive: true, force: true });
    if (options.copy === true) {
      fs.cpSync(this.snapshotDir(from), target, { recursive: true });
    } else {
      fs.renameSync(this.snapshotDir(from), target);
    }
    writeJson(this.metaFile(to), meta);
  }

  /** @param {EditResult} result */
  writeResult(result) {
    fs.mkdirSync(this.file("results"), { recursive: true });
    const name = `${String(result.covers).padStart(6, "0")}.json`;
    writeJson(path.join(this.file("results"), name), result);
  }

  /**
   * Takes every waiting answer, oldest first. Each is moved to
   * `delivered/` before it is read, so two hooks running at once never
   * deliver the same answer twice.
   *
   * @returns {EditResult[]}
   */
  claimResults() {
    const waiting = this.file("results");
    if (!fs.existsSync(waiting)) {
      return [];
    }
    fs.mkdirSync(this.file("delivered"), { recursive: true });
    /** @type {EditResult[]} */
    const claimed = [];
    for (const name of fs.readdirSync(waiting).sort()) {
      const target = path.join(this.file("delivered"), name);
      if (!name.endsWith(".json") || !moved(path.join(waiting, name), target)) {
        continue;
      }

      const result = readJson(target, null);
      if (result !== null) {
        claimed.push(result);
      }
    }
    return claimed;
  }

  /** @returns {StopRecord} */
  stopRecord() {
    return readJson(this.file("stops.json"), { blocked: [], runReported: [] });
  }

  /** @param {StopRecord} record */
  setStopRecord(record) {
    writeJson(this.file("stops.json"), record);
  }

  /** @param {Record<string, unknown>} entry */
  appendReport(entry) {
    appendLine(this.file("reports.jsonl"), {
      at: new Date().toISOString(),
      ...entry,
    });
  }

  /** @returns {string | null} */
  disabledReason() {
    return readJson(this.file("disabled.json"), { reason: null }).reason;
  }

  /** @param {string} reason */
  disable(reason) {
    writeJson(this.file("disabled.json"), { reason });
  }

  toldDisabled() {
    return readJson(this.file("disabled.json"), { told: false }).told === true;
  }

  markToldDisabled() {
    writeJson(this.file("disabled.json"), {
      reason: this.disabledReason(),
      told: true,
    });
  }

  ended() {
    return fs.existsSync(this.file("ended"));
  }

  /** A resumed session starts over from a fresh baseline. */
  reopen() {
    fs.rmSync(this.file("ended"), { force: true });
  }

  /**
   * Marks the session over and drops the snapshots, which are most of
   * the record's size. Prompts, the queue and the reports stay.
   */
  end() {
    fs.writeFileSync(this.file("ended"), new Date().toISOString());
    fs.rmSync(path.join(this.dir, "state"), { recursive: true, force: true });
  }

  /** @param {string} line */
  log(line) {
    fs.appendFileSync(
      this.file("worker.log"),
      `${new Date().toISOString()} ${line}\n`,
    );
  }

  /** @param {Snapshot} name */
  metaFile(name) {
    return path.join(this.dir, "state", `${name}.json`);
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
function moved(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function appendLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** @param {string} file */
function readLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/**
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
