import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { errorLineOf, readInChild, stopReadsAndEnd } from "./readInChild.js";

const limits = { jobs: 1, timeoutMs: 60_000, memoryMb: 1024 };

describe("a read in its own process", () => {
  it("comes back failed with the reason when it cannot start", async () => {
    const read = await readInChild(
      { kind: "extract", language: "typescript", packs: ["axios"] },
      path.join(os.tmpdir(), "suss-no-such-folder", "shop"),
      path.join(os.tmpdir(), "suss-no-such-folder", "out.json"),
      limits,
    );

    expect(read.end).toEqual({ kind: "failed", exitCode: null, signal: null });
    expect(read.output).toContain("ENOENT");
  });
});

describe("the line a failed read is reported by", () => {
  it("is the message of a stack trace", () => {
    expect(
      errorLineOf(
        "Reading 3 files\nError: tsconfig.json is not JSON\n    at parse (x.js:1:1)\n",
      ),
    ).toBe("Error: tsconfig.json is not JSON");
  });

  it("is the first line of the last paragraph when there is no trace", () => {
    expect(
      errorLineOf(
        'Pack health (1):\n  ok\n\nUnknown pack: "nope".\nBuilt in: express, hono\n',
      ),
    ).toBe('Unknown pack: "nope".');
  });

  it("is missing when the read printed nothing", () => {
    expect(errorLineOf("\n\n")).toBeNull();
  });
});

describe("a signal to this process", () => {
  it("stops the reads, then sends the signal on so the process ends as it would have", () => {
    const sent: string[] = [];

    stopReadsAndEnd("SIGTERM", (signal) => sent.push(signal));

    expect(sent).toEqual(["SIGTERM"]);
    expect(process.listeners("SIGTERM")).not.toContain(stopReadsAndEnd);
  });
});
