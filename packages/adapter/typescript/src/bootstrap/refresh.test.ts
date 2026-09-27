/**
 * An adapter kept between runs has to say what a fresh adapter says.
 * A long-lived process keeps one adapter per project, calls `refresh`
 * after files change, and runs again on the same ts-morph project. Each
 * test here edits the tree on disk and compares that second run with a
 * run from a new adapter over the same files.
 */

import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// A run from source turns the cache off. The test that asks for a cache
// directory needs it on, and the rest pass null.
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
}));

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const pack: PatternPack = {
  name: "test-kept-adapter",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["get"] } },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function write(dir: string, rel: string, text: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
}

/** A handler whose status comes from a helper in another file. */
async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "suss-kept-"));
  tempDirs.push(dir);
  await write(dir, "package.json", JSON.stringify({ name: "orders" }));
  await write(
    dir,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
      },
      include: ["src"],
    }),
  );
  await write(
    dir,
    "src/orders.ts",
    [
      'import { statusFor } from "./status";',
      "export function get(id: string): number {",
      "  return statusFor(id);",
      "}",
    ].join("\n"),
  );
  await write(dir, "src/status.ts", statusFile(200));
  return dir;
}

function statusFile(status: number): string {
  return [
    "export function statusFor(id: string): number {",
    `  return id === "" ? 400 : ${status};`,
    "}",
  ].join("\n");
}

function adapterFor(dir: string) {
  return createTypeScriptAdapter({
    tsConfigFilePath: path.join(dir, "tsconfig.json"),
    frameworks: [pack],
    cacheDir: null,
  });
}

async function freshRun(dir: string): Promise<BehavioralSummary[]> {
  return await adapterFor(dir).extractAll();
}

/**
 * Stats `file` with its mtime and ctime held at `at`, as a file system
 * whose clock has not ticked since would report them. `Date.now()` stays
 * at `at` too, so however long the test runs, no time has passed.
 * Returns the undo.
 */
function holdClockFor(file: string, at: number): () => void {
  vi.useFakeTimers({ toFake: ["Date"], now: at });
  const hold = <S extends { mtimeMs: number; ctimeMs: number }>(
    target: unknown,
    stat: S,
  ): S => {
    if (String(target) === file) {
      stat.mtimeMs = at;
      stat.ctimeMs = at;
    }
    return stat;
  };
  const realSync = nodeFs.statSync;
  const realAsync = fs.stat.bind(fs);
  const sync = vi
    .spyOn(nodeFs, "statSync")
    .mockImplementation(((target: nodeFs.PathLike) =>
      hold(target, realSync(target))) as typeof nodeFs.statSync);
  const promised = vi
    .spyOn(fs, "stat")
    .mockImplementation((async (target: nodeFs.PathLike) =>
      hold(target, await realAsync(target))) as typeof fs.stat);
  return () => {
    sync.mockRestore();
    promised.mockRestore();
    vi.useRealTimers();
  };
}

/** What a run writes, as the bytes a caller compares. */
function comparable(summaries: BehavioralSummary[]): string {
  return JSON.stringify(summaries);
}

describe("an adapter kept between runs", () => {
  it("reads a changed helper again and says what a fresh adapter says", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);
    const before = await kept.extractAll();

    await write(dir, "src/status.ts", statusFile(503));
    const report = kept.refresh();
    const after = await kept.extractAll();

    expect(report.changed).toEqual([path.join(dir, "src/status.ts")]);
    expect(report.startedOver).toBeNull();
    expect(comparable(after)).not.toEqual(comparable(before));
    expect(comparable(after)).toEqual(comparable(await freshRun(dir)));
  });

  it("reads a file written after the refresh, with the cache on and a clock that did not tick", async () => {
    const dir = await makeProject();
    const status = path.join(dir, "src/status.ts");
    const release = holdClockFor(status, Date.now());
    try {
      const kept = createTypeScriptAdapter({
        tsConfigFilePath: path.join(dir, "tsconfig.json"),
        frameworks: [pack],
        cacheDir: path.join(dir, ".suss", "cache"),
      });
      await kept.extractAll();

      await write(dir, "src/status.ts", statusFile(503));
      kept.refresh();
      await write(dir, "src/status.ts", statusFile(504));
      const during = await kept.extractAll();
      kept.refresh();
      const after = await kept.extractAll();

      const fresh = comparable(await freshRun(dir));
      expect(comparable(during)).toEqual(fresh);
      expect(comparable(after)).toEqual(fresh);
    } finally {
      release();
    }
  });

  it("compares a file again when a write in the same clock tick kept its stamp", async () => {
    const dir = await makeProject();
    const release = holdClockFor(path.join(dir, "src/status.ts"), Date.now());
    try {
      const kept = adapterFor(dir);
      await kept.extractAll();
      kept.refresh();

      await write(dir, "src/status.ts", statusFile(503));
      kept.refresh();
      const after = await kept.extractAll();

      expect(comparable(after)).toEqual(comparable(await freshRun(dir)));
    } finally {
      release();
    }
  });

  it("parses nothing again when a file was written with the same text", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);
    await kept.extractAll();

    await write(dir, "src/status.ts", statusFile(200));

    expect(kept.refresh().changed).toEqual([]);
  });

  it("re-reads a file the caller passes even when its stamp did not move", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);
    await kept.extractAll();
    const file = path.join(dir, "src/status.ts");
    const { mtime } = await fs.stat(file);
    await fs.writeFile(file, statusFile(201));
    await fs.utimes(file, mtime, mtime);

    kept.refresh([file]);
    const after = await kept.extractAll();

    expect(comparable(after)).toEqual(comparable(await freshRun(dir)));
  });

  it("starts over when a file joins the include set", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);
    await kept.extractAll();
    const project = kept.tsProject;

    await write(
      dir,
      "src/invoices.ts",
      "export function get(): number {\n  return 202;\n}",
    );
    kept.refresh();
    const after = await kept.extractAll();

    expect(kept.tsProject).not.toBe(project);
    expect(comparable(after)).toEqual(comparable(await freshRun(dir)));
  });

  it("starts over when a loaded file is deleted", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);
    await kept.extractAll();

    await fs.rm(path.join(dir, "src/status.ts"));
    const report = kept.refresh();
    const after = await kept.extractAll();

    expect(report.startedOver).toContain("status.ts");
    expect(comparable(after)).toEqual(comparable(await freshRun(dir)));
  });

  it("loads the program ahead of the first run that needs it", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);

    await kept.loadProgram();
    const loaded = kept.tsProject
      .getSourceFiles()
      .map((sourceFile) => path.basename(sourceFile.getFilePath()));

    expect(loaded).toEqual(expect.arrayContaining(["orders.ts", "status.ts"]));
    expect(comparable(await kept.extractAll())).toEqual(
      comparable(await freshRun(dir)),
    );
  });

  it("compares the loaded files with their parse ahead of the first edit", async () => {
    const dir = await makeProject();
    const kept = adapterFor(dir);
    await kept.extractAll();
    // A file changed moments ago is compared on every refresh, so the
    // project's files are made to look a minute old.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    const reads = vi.spyOn(nodeFs, "readFileSync");
    try {
      await kept.loadProgram();
      reads.mockClear();
      kept.refresh();
      const sourceReads = reads.mock.calls.filter(([file]) =>
        String(file).startsWith(path.join(dir, "src")),
      );
      expect(sourceReads).toEqual([]);
    } finally {
      reads.mockRestore();
      vi.useRealTimers();
    }
  });
});
