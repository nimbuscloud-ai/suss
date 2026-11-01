import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CACHE_BUDGET_ENV,
  cacheBudget,
  DEFAULT_CACHE_BUDGET,
  keepWithinBudget,
} from "./cacheEviction.js";

let cacheDir: string;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-eviction-"));
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const KB = 1024;

/** A stored file's id, made from a short label. */
function idOf(label: string): string {
  return label.padEnd(32, "0").replace(/[^0-9a-f]/g, "a");
}

function entry(key: string): string {
  return path.join(cacheDir, `key-${key.padEnd(16, "0")}`);
}

/** Writes a shard of `bytes` bytes into an entry, an hour ago, so no writer still listing it is waited for. */
function shard(entryDir: string, label: string, bytes: number): void {
  const id = idOf(label);
  const dir = path.join(entryDir, "shards", id.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, "x".repeat(bytes));
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, hourAgo, hourAgo);
}

/** Writes a checkout that lists the given shards, last used `minutesAgo` minutes ago. */
function checkout(
  entryDir: string,
  name: string,
  labels: string[],
  minutesAgo: number,
  root?: string,
): string {
  const dir = path.join(entryDir, "checkouts", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "stored.json"),
    JSON.stringify(labels.map(idOf)),
  );
  if (root !== undefined) {
    fs.writeFileSync(path.join(dir, "root.txt"), root);
  }
  const at = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(dir, at, at);
  return dir;
}

const exists = (file: string): boolean => fs.existsSync(file);

describe("keepWithinBudget", () => {
  it("keeps the most recently used checkouts that fit and removes the older ones", async () => {
    const first = entry("a1");
    const second = entry("b2");
    shard(first, "a1", 100 * KB);
    shard(second, "b2", 100 * KB);
    shard(second, "c3", 100 * KB);
    const own = checkout(first, "own", ["a1"], 0);
    const recent = checkout(second, "recent", ["b2"], 5);
    const older = checkout(second, "older", ["c3"], 10);

    await keepWithinBudget(cacheDir, own, 250 * KB);

    expect(exists(own)).toBe(true);
    expect(exists(recent)).toBe(true);
    expect(exists(older)).toBe(false);
    // The shard only the removed checkout listed goes with it.
    expect(exists(path.join(second, "shards", "c3"))).toBe(true);
    expect(fs.readdirSync(path.join(second, "shards", "c3"))).toEqual([]);
  });

  it("counts a shard two checkouts of one entry share once", async () => {
    const one = entry("a1");
    shard(one, "a1", 100 * KB);
    const own = checkout(one, "own", ["a1"], 0);
    const other = checkout(one, "other", ["a1"], 5);

    await keepWithinBudget(cacheDir, own, 150 * KB);

    expect(exists(other)).toBe(true);
  });

  it("keeps the writing checkout when it alone is past the budget", async () => {
    const one = entry("a1");
    shard(one, "a1", 100 * KB);
    const own = checkout(one, "own", ["a1"], 10);

    await keepWithinBudget(cacheDir, own, 1);

    expect(exists(own)).toBe(true);
    expect(fs.readdirSync(path.join(one, "shards", "a1"))).toHaveLength(1);
  });

  it("removes an entry once it has no checkout left", async () => {
    const mine = entry("a1");
    const theirs = entry("b2");
    shard(mine, "a1", 100 * KB);
    shard(theirs, "b2", 100 * KB);
    const own = checkout(mine, "own", ["a1"], 0);
    checkout(theirs, "old", ["b2"], 10);

    await keepWithinBudget(cacheDir, own, 150 * KB);

    expect(exists(theirs)).toBe(false);
  });

  it("removes a checkout whose worktree is gone, within the budget or not", async () => {
    const one = entry("a1");
    shard(one, "a1", KB);
    const own = checkout(one, "own", ["a1"], 0);
    const gone = checkout(one, "gone", ["a1"], 5, path.join(cacheDir, "nope"));
    const here = checkout(one, "here", ["a1"], 5, cacheDir);

    await keepWithinBudget(cacheDir, own, DEFAULT_CACHE_BUDGET);

    expect(exists(gone)).toBe(false);
    expect(exists(here)).toBe(true);
  });

  it("counts an entry an older layout wrote without checkout folders as a whole", async () => {
    const mine = entry("a1");
    shard(mine, "a1", 100 * KB);
    const own = checkout(mine, "own", ["a1"], 0);
    const legacy = entry("b2");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "manifest.json"), "x".repeat(100 * KB));

    await keepWithinBudget(cacheDir, own, 150 * KB);

    expect(exists(legacy)).toBe(false);
  });

  it("leaves a directory it did not write alone", async () => {
    const mine = entry("a1");
    shard(mine, "a1", 100 * KB);
    const own = checkout(mine, "own", ["a1"], 0);
    const theirs = path.join(cacheDir, "somebody-elses-work");
    fs.mkdirSync(theirs);

    await keepWithinBudget(cacheDir, own, 1);

    expect(exists(theirs)).toBe(true);
  });
});

describe("cacheBudget", () => {
  it("reads megabytes from the environment, and the default otherwise", () => {
    expect(cacheBudget({ [CACHE_BUDGET_ENV]: "2" })).toBe(2 * 1024 * KB);
    expect(cacheBudget({ [CACHE_BUDGET_ENV]: "0.5" })).toBe(512 * KB);
    expect(cacheBudget({})).toBe(DEFAULT_CACHE_BUDGET);
    expect(cacheBudget({ [CACHE_BUDGET_ENV]: "lots" })).toBe(
      DEFAULT_CACHE_BUDGET,
    );
    expect(cacheBudget({ [CACHE_BUDGET_ENV]: "0" })).toBe(DEFAULT_CACHE_BUDGET);
  });
});
