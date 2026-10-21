import { describe, expect, it } from "vitest";

import { CACHE_DIR_ENV } from "@suss/extractor";

import { takeCacheDirFlag } from "./cacheDirFlag.js";
import { runCli } from "./run.js";
import { UsageError } from "./usageError.js";

describe("takeCacheDirFlag", () => {
  it("takes the flag and its value out of the arguments", () => {
    expect(
      takeCacheDirFlag(["--dir", "src", "--cache-dir", "/tmp/c", "-f", "x"]),
    ).toEqual({ args: ["--dir", "src", "-f", "x"], cacheDir: "/tmp/c" });
  });

  it("reads the = spelling", () => {
    expect(takeCacheDirFlag(["--cache-dir=/tmp/c", "a"])).toEqual({
      args: ["a"],
      cacheDir: "/tmp/c",
    });
  });

  it("leaves everything after -- alone", () => {
    expect(takeCacheDirFlag(["--", "--cache-dir", "x"])).toEqual({
      args: ["--", "--cache-dir", "x"],
      cacheDir: undefined,
    });
  });

  it("refuses a flag with no directory after it", () => {
    expect(() => takeCacheDirFlag(["--cache-dir"])).toThrow(UsageError);
    expect(() => takeCacheDirFlag(["--cache-dir", "--json"])).toThrow(
      /takes the directory/,
    );
  });
});

describe("a command line with --cache-dir", () => {
  it("does not leave the variable set for the next command line", async () => {
    delete process.env[CACHE_DIR_ENV];

    await runCli(["ask", "--cache-dir", "/from/flag"]);

    expect(process.env[CACHE_DIR_ENV]).toBeUndefined();
  });

  it("puts back a value that was already set", async () => {
    process.env[CACHE_DIR_ENV] = "/from/env";

    await runCli(["ask", "--cache-dir", "/from/flag"]);

    expect(process.env[CACHE_DIR_ENV]).toBe("/from/env");
    delete process.env[CACHE_DIR_ENV];
  });
});
