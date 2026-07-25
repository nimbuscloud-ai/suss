import fs from "node:fs";
import os from "node:os";

import { describe, expect, it } from "vitest";

import { run } from "./processRun.js";

const node = process.execPath;

describe("run", () => {
  it("returns the exit code and what the command printed", async () => {
    const result = await run(node, ["-e", "console.log('hello')"], os.tmpdir());

    expect(result.code).toBe(0);
    expect(result.output).toContain("hello");
  });

  it("keeps stderr, which is where a failure explains itself", async () => {
    const result = await run(
      node,
      ["-e", "console.error('went wrong'); process.exit(3)"],
      os.tmpdir(),
    );

    expect(result.code).toBe(3);
    expect(result.output).toContain("went wrong");
  });

  it("runs in the directory it was given", async () => {
    const result = await run(
      node,
      ["-e", "console.log(process.cwd())"],
      os.tmpdir(),
    );

    expect(result.output.trim()).toContain(fs.realpathSync(os.tmpdir()));
  });

  it("reports a command that is not there rather than throwing", async () => {
    const result = await run("suss-no-such-command", [], os.tmpdir());

    expect(result.code).toBe(1);
    expect(result.output).toContain("ENOENT");
  });
});
