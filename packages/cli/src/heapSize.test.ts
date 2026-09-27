import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  availableMemoryMb,
  heapSizeFor,
  heapSizeToRelaunchWith,
  heapSizeWasChosen,
  PREFERRED_HEAP_MB,
} from "./heapSize.js";

describe("heapSizeWasChosen", () => {
  it("sees a heap size in NODE_OPTIONS, spelled either way", () => {
    expect(heapSizeWasChosen("--max-old-space-size=2048", [])).toBe(true);
    expect(heapSizeWasChosen("--inspect --max_old_space_size=2048", [])).toBe(
      true,
    );
  });

  it("sees a heap size passed to node directly", () => {
    expect(heapSizeWasChosen(undefined, ["--max-old-space-size=2048"])).toBe(
      true,
    );
  });

  it("ignores other options", () => {
    expect(heapSizeWasChosen("--enable-source-maps", ["--cpu-prof"])).toBe(
      false,
    );
    expect(heapSizeWasChosen(undefined, [])).toBe(false);
  });
});

describe("heapSizeFor", () => {
  it("uses the preferred size on a machine with room for it", () => {
    expect(heapSizeFor(32768)).toBe(PREFERRED_HEAP_MB);
  });

  it("keeps to three quarters of memory on a small machine", () => {
    expect(heapSizeFor(4096)).toBe(3072);
  });
});

describe("heapSizeToRelaunchWith", () => {
  const unset = {
    nodeOptions: undefined,
    execArgv: [],
    heapLimitMb: 4144,
    memoryMb: 32768,
  };

  it("relaunches when nobody chose a size and the default is smaller", () => {
    expect(heapSizeToRelaunchWith(unset)).toBe(PREFERRED_HEAP_MB);
  });

  it("leaves a size from NODE_OPTIONS alone, even a small one", () => {
    expect(
      heapSizeToRelaunchWith({
        ...unset,
        nodeOptions: "--max-old-space-size=1024",
      }),
    ).toBeUndefined();
  });

  it("leaves a size passed to node alone", () => {
    expect(
      heapSizeToRelaunchWith({
        ...unset,
        execArgv: ["--max-old-space-size=1024"],
      }),
    ).toBeUndefined();
  });

  it("does not relaunch when the default is already as large", () => {
    expect(
      heapSizeToRelaunchWith({ ...unset, heapLimitMb: 9000 }),
    ).toBeUndefined();
  });
});

describe("availableMemoryMb", () => {
  it("is no more than the machine has", () => {
    const machineMb = Math.floor(os.totalmem() / (1024 * 1024));
    const available = availableMemoryMb();
    expect(available).toBeGreaterThan(0);
    expect(available).toBeLessThanOrEqual(machineMb);
  });
});

// These run the built module in a fresh node, since relaunching the test
// process itself is not something a test can do.
describe("startWithEnoughHeap in a fresh process", () => {
  const dist = path.resolve(__dirname, "../dist/heapSize.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-heap-size-"));
  const script = path.join(dir, "report.mjs");
  fs.writeFileSync(
    script,
    [
      'import v8 from "node:v8";',
      `import { startWithEnoughHeap } from ${JSON.stringify(pathToFileURL(dist).href)};`,
      "startWithEnoughHeap(() => {",
      "  const limitMb = Math.floor(v8.getHeapStatistics().heap_size_limit / 1048576);",
      "  process.stdout.write(JSON.stringify({ limitMb, args: process.argv.slice(2) }));",
      "  process.exitCode = Number(process.argv[2]);",
      "});",
    ].join("\n"),
  );

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(nodeOptions: string | undefined, args: string[]) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (nodeOptions !== undefined) {
      env.NODE_OPTIONS = nodeOptions;
    }
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      report: JSON.parse(result.stdout) as { limitMb: number; args: string[] },
    };
  }

  it("runs with the larger heap, and keeps the arguments and exit code", () => {
    const { status, stderr, report } = run(undefined, ["3", "--flag", "x y"]);
    expect(stderr).toBe("");
    expect(status).toBe(3);
    expect(report.args).toEqual(["3", "--flag", "x y"]);
    expect(report.limitMb).toBeGreaterThanOrEqual(
      heapSizeFor(availableMemoryMb()),
    );
  });

  it("keeps the heap size NODE_OPTIONS sets", () => {
    const { status, report } = run("--max-old-space-size=512", ["0"]);
    expect(status).toBe(0);
    expect(report.limitMb).toBeLessThan(1024);
  });
});
