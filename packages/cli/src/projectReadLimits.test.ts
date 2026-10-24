// Reads a project the way a bare `check` or `map` does: each extract in
// its own `suss` process, several at once, each stopped at its limits.
// The child processes run the package's build, which `test` builds first.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkDir } from "./check.js";
import {
  clearEarlierReads,
  commandFor,
  declaredReads,
  readProjectInto,
  readProjectSaying,
} from "./projectRead.js";
import { stopEveryRead } from "./readInChild.js";

import type { ReadProgress } from "./projectRead.js";
import type { ReadLimits } from "./readLimits.js";

const MONOREPO = path.resolve(
  import.meta.dirname,
  "../../../fixtures/typescript-monorepo",
);

const copies: string[] = [];

afterEach(() => {
  for (const copy of copies.splice(0)) {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-read-limits-"));
  copies.push(dir);
  return dir;
}

/** A copy of the monorepo fixture, with this `read` list when one is given. */
function monorepo(read?: unknown[]): string {
  const root = path.join(tempDir(), "shop");
  fs.cpSync(MONOREPO, root, { recursive: true });
  if (read !== undefined) {
    fs.writeFileSync(
      path.join(root, "suss.json"),
      JSON.stringify({ version: 1, read }),
    );
  }
  return root;
}

const SPEC = `openapi: 3.0.0
info: { title: shop, version: "1" }
paths:
  /orders:
    get:
      responses:
        "200": { description: ok }
`;

const roomy: ReadLimits = { jobs: 2, timeoutMs: 120_000, memoryMb: 2048 };

describe("a project with no suss.json", () => {
  it("reads each workspace package on its own, as init would list them", async () => {
    const found = await declaredReads(monorepo());

    expect(found.declared).toBe(false);
    expect(
      found.reads.map((entry) =>
        entry.kind === "extract" ? (entry.dir ?? ".") : entry.file,
      ),
    ).toEqual([".", "packages/api", "packages/web"]);
  });
});

describe("reading a project with limits", () => {
  it("runs each extract in its own process and says how each one ended", async () => {
    const root = monorepo();
    const reads = await declaredReads(root);
    const events: ReadProgress[] = [];

    const report = await readProjectInto(root, tempDir(), reads, {
      limits: roomy,
      onProgress: (event) => events.push(event),
    });

    expect(report.failed).toEqual([]);
    expect(report.ran).toEqual(reads.reads.map(commandFor));
    expect(report.counts.some((count) => count > 0)).toBe(true);
    expect(events.filter((event) => event.kind === "started")).toHaveLength(3);
    const ended = events.filter((event) => event.kind === "ended");
    expect(ended.map((event) => event.done)).toEqual([1, 2, 3]);
    expect(ended.every((event) => event.total === 3)).toBe(true);
  }, 180_000);

  it("stops a read at its time limit and checks the reads that finished", async () => {
    const root = monorepo([
      { kind: "extract", language: "typescript", packs: ["axios"] },
      { kind: "contract", from: "openapi", file: "openapi.yaml" },
    ]);
    fs.writeFileSync(path.join(root, "openapi.yaml"), SPEC);
    const dir = tempDir();

    const report = await readProjectInto(root, dir, await declaredReads(root), {
      limits: { ...roomy, timeoutMs: 1 },
    });

    expect(report.failed).toEqual([
      "suss extract --lang typescript -f axios: was stopped after 1ms, the time limit for one read. Pass --read-timeout with more minutes to give it longer, or 0 for no limit.",
    ]);
    expect(report.ran).toEqual(["suss contract --from openapi openapi.yaml"]);
    expect(fs.existsSync(path.join(dir, "0-extract.json"))).toBe(false);

    const checked = checkDir({
      dir,
      json: true,
      output: path.join(tempDir(), "out.json"),
    });
    expect(checked.run).toContainEqual({
      kind: "readFailed",
      severity: "warning",
      description:
        "`suss extract --lang typescript -f axios` was stopped after 1ms, the time limit for one read, so the summaries it would have written are missing from this check.",
      remedy:
        "Pass --read-timeout with more minutes to give it longer, or 0 for no limit. Then run the check again.",
    });
  }, 180_000);

  it("says a read ran out of heap, and which flag gives it more", async () => {
    const root = monorepo([
      { kind: "extract", language: "typescript", packs: ["axios"] },
    ]);

    const report = await readProjectInto(
      root,
      tempDir(),
      await declaredReads(root),
      {
        limits: { ...roomy, memoryMb: 8 },
      },
    );

    expect(report.failed).toEqual([
      "suss extract --lang typescript -f axios: ran out of its 8 MB heap. Pass --read-memory with more megabytes, or --jobs 1 so it has the machine to itself.",
    ]);
  }, 180_000);

  it("gives the error a read stopped on", async () => {
    const root = monorepo([
      { kind: "extract", language: "typescript", packs: ["no-such-pack"] },
    ]);

    const report = await readProjectInto(
      root,
      tempDir(),
      await declaredReads(root),
      {
        limits: roomy,
      },
    );

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatch(
      /^suss extract --lang typescript -f no-such-pack: exited with code 1: .*no-such-pack/,
    );
  }, 180_000);

  it("prints a line as each read starts and as it ends", async () => {
    const root = monorepo([
      { kind: "contract", from: "openapi", file: "openapi.yaml" },
    ]);
    fs.writeFileSync(path.join(root, "openapi.yaml"), SPEC);
    const printed: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await readProjectSaying(root, tempDir(), true, roomy);
    } finally {
      process.stderr.write = write;
    }

    const text = printed.join("");
    expect(text).toContain("1 read, one at a time, each stopped after 2m 0s:");
    expect(text).toContain(
      "  started  suss contract --from openapi openapi.yaml\n",
    );
    expect(text).toMatch(
      /\[1\/1\] suss contract --from openapi openapi\.yaml: 1 summary in \d/,
    );
  });

  it("lists the reads and prints what each extract printed, when not quiet", async () => {
    const root = monorepo([
      { kind: "extract", language: "typescript", packs: ["axios"] },
    ]);

    const text = await stderrOf(() =>
      readProjectSaying(root, tempDir(), false, roomy),
    );

    expect(text).toContain("\n  suss extract --lang typescript -f axios\n");
    expect(text).toMatch(/\n {6}Wrote \d+ summar/);
  }, 180_000);

  it("runs the reads one at a time in this process without limits", async () => {
    const root = monorepo([
      { kind: "extract", language: "typescript", packs: ["axios"] },
    ]);

    const text = await stderrOf(() => readProjectSaying(root, tempDir(), true));

    expect(text).toContain("1 read, one at a time:");
    expect(text).toMatch(
      /\[1\/1\] suss extract --lang typescript -f axios: \d+ summar/,
    );
  }, 180_000);
});

async function stderrOf(run: () => Promise<unknown>): Promise<string> {
  const printed: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    printed.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return printed.join("");
}

describe("stopping the reads", () => {
  it("kills a read still running, as this process does when it exits", async () => {
    const root = monorepo([
      { kind: "extract", language: "typescript", packs: ["axios"] },
    ]);

    const reading = readProjectInto(
      root,
      tempDir(),
      await declaredReads(root),
      {
        limits: { ...roomy, timeoutMs: 0 },
        onProgress: (event) => {
          if (event.kind === "started") {
            setTimeout(stopEveryRead, 200);
          }
        },
      },
    );

    expect((await reading).failed).toEqual([
      "suss extract --lang typescript -f axios: was stopped by SIGKILL",
    ]);
  }, 180_000);
});

describe("clearing an earlier read", () => {
  it("removes the note a failed read left as well as the summaries", () => {
    const dir = tempDir();
    for (const name of [
      "0-extract.json",
      "0-extract.incomplete.json",
      "1-contract.json",
      "notes.json",
    ]) {
      fs.writeFileSync(path.join(dir, name), "[]");
    }

    clearEarlierReads(dir);

    expect(fs.readdirSync(dir)).toEqual(["notes.json"]);
  });
});
