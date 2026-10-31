import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CACHE_DIR_ENV,
  extractionCacheDirFor,
  liveRecordFor,
  mapFolderFor,
} from "./cacheLocation.js";

const before = process.env[CACHE_DIR_ENV];
const made: string[] = [];

afterEach(() => {
  if (before === undefined) {
    delete process.env[CACHE_DIR_ENV];
  } else {
    process.env[CACHE_DIR_ENV] = before;
  }
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repository with one commit, in a fresh folder: `main` is its checkout. */
function gitRepository(): { parent: string; main: string } {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-location-")),
  );
  made.push(parent);
  const main = path.join(parent, "main");
  fs.mkdirSync(path.join(main, "api"), { recursive: true });
  fs.writeFileSync(path.join(main, "api", "app.py"), "x = 1\n");
  git(main, "init", "-q");
  git(main, "add", ".");
  git(
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "first",
  );
  return { parent, main };
}

describe("where suss keeps its own files", () => {
  it("is under .suss in the project when nothing is chosen", () => {
    delete process.env[CACHE_DIR_ENV];

    expect(extractionCacheDirFor("/work/shop")).toBe(
      path.join("/work/shop", ".suss", "cache"),
    );
    expect(liveRecordFor("/work/shop")).toBe(
      path.join("/work/shop", ".suss", "live", "server.json"),
    );
    expect(mapFolderFor("/work/shop")).toBe(path.join("/work/shop", ".suss"));
  });

  it("puts each project's map in its own folder under the chosen directory", () => {
    process.env[CACHE_DIR_ENV] = "/tmp/state";

    const shop = mapFolderFor("/work/shop");

    expect(shop.startsWith(path.join("/tmp/state", "map"))).toBe(true);
    expect(shop).not.toBe(mapFolderFor("/work/blog"));
  });

  it("is under the chosen directory, apart for each project", () => {
    process.env[CACHE_DIR_ENV] = "/tmp/state";

    const shop = extractionCacheDirFor("/work/shop");
    const blog = extractionCacheDirFor("/work/blog");

    expect(shop.startsWith(path.join("/tmp/state", "cache"))).toBe(true);
    expect(blog.startsWith(path.join("/tmp/state", "cache"))).toBe(true);
    expect(shop).not.toBe(blog);
    expect(liveRecordFor("/work/shop").startsWith("/tmp/state")).toBe(true);
  });

  it("is one cache for every worktree of a repository", () => {
    delete process.env[CACHE_DIR_ENV];
    const repo = gitRepository();
    const worktree = path.join(repo.parent, "linked");
    git(repo.main, "worktree", "add", "-q", worktree);

    expect(extractionCacheDirFor(path.join(worktree, "api"))).toBe(
      path.join(repo.main, "api", ".suss", "cache"),
    );
    expect(liveRecordFor(worktree)).toBe(
      path.join(worktree, ".suss", "live", "server.json"),
    );

    process.env[CACHE_DIR_ENV] = path.join(repo.parent, "state");

    expect(extractionCacheDirFor(path.join(worktree, "api"))).toBe(
      extractionCacheDirFor(path.join(repo.main, "api")),
    );
    expect(extractionCacheDirFor(worktree)).not.toBe(
      extractionCacheDirFor(path.join(worktree, "api")),
    );
  });

  it("reads an empty variable as not chosen", () => {
    process.env[CACHE_DIR_ENV] = "";

    expect(extractionCacheDirFor("/work/shop")).toBe(
      path.join("/work/shop", ".suss", "cache"),
    );
  });
});
