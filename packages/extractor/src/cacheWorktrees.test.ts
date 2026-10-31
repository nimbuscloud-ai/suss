/**
 * One extraction cache for every worktree of a repository. A worktree
 * with no manifest of its own starts from another checkout's, keeps every
 * file whose content matches, and reads the summaries back with its own
 * paths.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDigest } from "./adapterStamp.js";
import { createCacheLayer } from "./cache.js";
import { extractionCacheDirFor } from "./cacheLocation.js";
import { storedPathsOfRun } from "./cachePaths.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CacheAttribution, CacheInput } from "./cache.js";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repository with `files` committed, and a second worktree of it. */
function repositoryWithWorktree(files: Record<string, string>): {
  main: string;
  linked: string;
} {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-worktrees-")),
  );
  made.push(parent);
  const main = path.join(parent, "main");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.writeFileSync(path.join(main, rel), text);
  }
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
  const linked = path.join(parent, "linked");
  git(main, "worktree", "add", "-q", linked);
  return { main, linked };
}

const FILES = {
  "tsconfig.json": "{}",
  "src/a.ts": "export const a = 1;",
  "src/b.ts": "export const b = 2;",
};

function unitIn(file: string, name: string): BehavioralSummary {
  return {
    kind: "library",
    location: { file, range: { start: 1, end: 1 }, exportName: name },
    identity: { name, exportPath: [name], boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function inputIn(checkout: string): CacheInput {
  return {
    files: ["src/a.ts", "src/b.ts"].map((rel) => path.join(checkout, rel)),
    adapterPacksDigest: `test@1|projectRoot=${checkout}`,
    configPath: path.join(checkout, "tsconfig.json"),
  };
}

/** What a run in `checkout` stores: one unit per file, each owned by its file. */
function summariesIn(checkout: string): {
  summaries: BehavioralSummary[];
  attribution: CacheAttribution;
} {
  const [a, b] = inputIn(checkout).files as [string, string];
  const summaries = [unitIn(a, "a"), unitIn(b, "b")];
  return {
    summaries,
    attribution: {
      roots: [a, b].map((file) => ({
        path: file,
        cacheable: true,
        deps: [b],
        claims: [],
        meta: { readFrom: file },
        packs: [],
      })),
      owners: [[a], [b]],
    },
  };
}

async function writeIn(
  checkout: string,
  input = inputIn(checkout),
): Promise<void> {
  const { summaries, attribution } = summariesIn(checkout);
  const cache = createCacheLayer(extractionCacheDirFor(checkout));
  await cache.lookup(input);
  await cache.write(input, summaries, attribution);
}

/** A run's input when a pack also reads a template that no walk reads. */
function inputReadingTemplate(checkout: string): CacheInput {
  const input = inputIn(checkout);
  return {
    ...input,
    adapterPacksDigest: runDigest(
      input.adapterPacksDigest,
      [{ discoveryInputs: () => [path.join(checkout, "template.yaml")] }],
      input.files,
      storedPathsOfRun(input.configPath).paths.keyText,
    ),
  };
}

function shardsUnder(cacheDir: string): string[] {
  return fs
    .readdirSync(cacheDir, { recursive: true, encoding: "utf8" })
    .filter(
      (name) => name.includes(`shards${path.sep}`) && name.endsWith(".json"),
    );
}

describe("a cache shared by the worktrees of a repository", () => {
  it("lets a new worktree reuse every file another checkout read, with its own paths", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(main);
    const cache = createCacheLayer(extractionCacheDirFor(linked));
    const input = inputIn(linked);

    const lookup = await cache.lookup(input);
    const plan = await cache.plan(input);

    expect(lookup.diagnostic.missReason).toBe("files-changed");
    expect(plan?.changed).toEqual(new Set());
    expect([...(plan?.validRoots ?? [])]).toEqual(input.files);
    expect(plan?.roots.get(input.files[0] as string)?.meta).toEqual({
      readFrom: input.files[0],
    });
    expect(plan?.reuse(new Set(input.files)).summaries).toEqual(
      summariesIn(linked).summaries,
    );
  });

  it("shares the entry when a pack reads a file no walk reads", async () => {
    const { main, linked } = repositoryWithWorktree({
      ...FILES,
      "template.yaml": "Resources: {}",
    });
    await writeIn(main, inputReadingTemplate(main));
    const cache = createCacheLayer(extractionCacheDirFor(linked));

    const lookup = await cache.lookup(inputReadingTemplate(linked));

    expect(lookup.diagnostic.missReason).toBe("files-changed");
  });

  it("re-extracts only what a worktree changed, and what read it", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(main);
    fs.writeFileSync(path.join(linked, "src/a.ts"), "export const a = 10;");
    const cache = createCacheLayer(extractionCacheDirFor(linked));
    const input = inputIn(linked);
    await cache.lookup(input);

    const plan = await cache.plan(input);

    expect(plan?.changed).toEqual(new Set([path.join(linked, "src/a.ts")]));
    expect([...(plan?.validRoots ?? [])]).toEqual([
      path.join(linked, "src/b.ts"),
    ]);
  });

  it("keeps one shard for a file both checkouts have the same", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(main);
    const cacheDir = extractionCacheDirFor(main);
    const before = shardsUnder(cacheDir);

    await writeIn(linked);

    expect(extractionCacheDirFor(linked)).toBe(cacheDir);
    expect(shardsUnder(cacheDir)).toEqual(before);
  });

  it("hits in each checkout after each has written its own manifest", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(main);
    await writeIn(linked);

    for (const checkout of [main, linked]) {
      const cache = createCacheLayer(extractionCacheDirFor(checkout));
      expect(await cache.tryHit(inputIn(checkout))).toEqual(
        summariesIn(checkout).summaries,
      );
    }
  });

  it("drops a removed worktree's manifest at the next write", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(linked);
    const checkouts = checkoutsOf(main);
    expect(fs.readdirSync(checkouts)).toHaveLength(1);

    git(main, "worktree", "remove", "--force", linked);
    await writeIn(main);

    expect(fs.readdirSync(checkouts)).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(checkouts, fs.readdirSync(checkouts)[0] ?? "", "root.txt"),
        "utf8",
      ),
    ).toBe(main);
  });

  it("starts cold when the other checkout's folder has no manifest", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(main);
    for (const name of fs.readdirSync(checkoutsOf(main))) {
      fs.rmSync(path.join(checkoutsOf(main), name, "manifest.json"));
    }
    const cache = createCacheLayer(extractionCacheDirFor(linked));

    const lookup = await cache.lookup(inputIn(linked));

    expect(lookup.kind).toBe("miss");
    expect(lookup.diagnostic.missReason).not.toBe("files-changed");
    expect(await cache.plan(inputIn(linked))).toBeNull();
  });

  it("keeps a folder a write left without its list or its root", async () => {
    const { main, linked } = repositoryWithWorktree(FILES);
    await writeIn(linked);
    const crashed = path.join(checkoutsOf(main), "crashed");
    fs.mkdirSync(crashed);
    fs.writeFileSync(path.join(crashed, "stored.json"), "not a list");

    await writeIn(main);

    expect(fs.readdirSync(checkoutsOf(main))).toContain("crashed");
    expect(
      await createCacheLayer(extractionCacheDirFor(main)).tryHit(inputIn(main)),
    ).toEqual(summariesIn(main).summaries);
  });
});

/** The folder of checkouts in the repository's one entry. */
function checkoutsOf(checkout: string): string {
  const cacheDir = extractionCacheDirFor(checkout);
  const entry =
    fs.readdirSync(cacheDir).find((name) => name.startsWith("key-")) ?? "";
  return path.join(cacheDir, entry, "checkouts");
}
