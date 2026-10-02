import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extract } from "./extract.js";
import { KeptAdapters } from "./keptAdapters.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const pythonFixture = path.join(repoRoot, "fixtures", "python-webapp");

function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeRoute(root: string, routePath: string): void {
  fs.writeFileSync(
    path.join(root, "src", "app.ts"),
    [
      'import express from "express";',
      "const app = express();",
      `app.get("${routePath}", (req, res) => {`,
      "  res.status(200).json({ ok: true });",
      "});",
    ].join("\n"),
  );
}

function expressProject(): string {
  const root = tempDir("suss-kept-ts-");
  fs.mkdirSync(path.join(root, "src"));
  writeRoute(root, "/orders");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", strict: true },
      include: ["src"],
    }),
  );
  return root;
}

class CountingKeptAdapters extends KeptAdapters {
  made = 0;

  override keep<T>(
    slot: string,
    key: string,
    make: () => T,
    prepare?: (value: T) => Promise<void>,
  ): T {
    return super.keep(
      slot,
      key,
      () => {
        this.made += 1;
        return make();
      },
      prepare,
    );
  }
}

function routes(summaries: Awaited<ReturnType<typeof extract>>): unknown[] {
  return summaries.map(
    (summary) => summary.identity.boundaryBinding?.semantics,
  );
}

describe("extract with kept adapters", () => {
  it("reads an edit through the adapter the last run left, and says what a fresh run says", async () => {
    const root = expressProject();
    const kept = new KeptAdapters();
    const run = (extra: { kept?: KeptAdapters; noCache?: boolean }) =>
      extract({
        tsconfig: path.join(root, "tsconfig.json"),
        frameworks: ["express"],
        output: path.join(root, "out.json"),
        ...extra,
      });

    await run({ kept });
    await kept.prepare();
    writeRoute(root, "/invoices");
    kept.noteChanged([path.join(root, "src", "app.ts")]);
    kept.startRead();
    const kept2 = await run({ kept });
    const fresh = await run({ noCache: true });

    expect(kept.size).toBe(1);
    expect(routes(kept2)).toEqual(routes(fresh));
    expect(JSON.stringify(routes(kept2))).toContain("/invoices");
  }, 60_000);

  it("keeps one adapter per directory read under one tsconfig", async () => {
    const root = expressProject();
    for (const name of ["orders", "billing"]) {
      fs.mkdirSync(path.join(root, "src", name));
      fs.copyFileSync(
        path.join(root, "src", "app.ts"),
        path.join(root, "src", name, "app.ts"),
      );
    }
    const kept = new CountingKeptAdapters();
    const run = (name: string) =>
      extract({
        dir: path.join(root, "src", name),
        frameworks: ["express"],
        output: path.join(root, `${name}.json`),
        noCache: true,
        kept,
      });

    for (const name of ["orders", "billing", "orders", "billing"]) {
      kept.startRead();
      await run(name);
    }

    expect(kept.size).toBe(2);
    expect(kept.made).toBe(2);
  }, 60_000);

  it("reads a directory with no tsconfig afresh each run, so an edit shows", async () => {
    const root = expressProject();
    fs.rmSync(path.join(root, "tsconfig.json"));
    const kept = new KeptAdapters();
    const run = () =>
      extract({
        dir: root,
        frameworks: ["express"],
        output: path.join(root, "out.json"),
        kept,
      });

    await run();
    writeRoute(root, "/invoices");
    const after = await run();

    expect(JSON.stringify(routes(after))).toContain("/invoices");
  }, 60_000);

  it("keeps a Python read's parses and parses ahead after a run", async () => {
    const root = tempDir("suss-kept-py-");
    fs.cpSync(path.join(pythonFixture, "myapp"), path.join(root, "myapp"), {
      recursive: true,
    });
    const kept = new KeptAdapters();
    const run = (extra: { kept?: KeptAdapters; noCache?: boolean }) =>
      extract({
        dir: root,
        frameworks: ["fastapi"],
        output: path.join(root, "out.json"),
        ...extra,
      });

    const first = await run({ kept });
    await kept.prepare();
    const second = await run({ kept });
    const fresh = await run({ noCache: true });

    expect(kept.size).toBe(1);
    expect(routes(second)).toEqual(routes(first));
    expect(routes(second)).toEqual(routes(fresh));
  }, 60_000);
});
