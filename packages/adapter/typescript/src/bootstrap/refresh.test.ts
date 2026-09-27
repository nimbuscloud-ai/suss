/**
 * An adapter kept between runs has to say what a fresh adapter says.
 * A long-lived process keeps one adapter per project, calls `refresh`
 * after files change, and runs again on the same ts-morph project. Each
 * test here edits the tree on disk and compares that second run with a
 * run from a new adapter over the same files.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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
});
