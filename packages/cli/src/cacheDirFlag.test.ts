import { describe, expect, it } from "vitest";

import { CACHE_DIR_ENV } from "@suss/extractor";

import { takeCacheDirFlag, withCacheDir } from "./cacheDirFlag.js";
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

describe("withCacheDir", () => {
  it("sets the variable for the run and puts it back after", async () => {
    process.env[CACHE_DIR_ENV] = "/from/env";

    const seen = await withCacheDir(
      "/from/flag",
      async () => process.env[CACHE_DIR_ENV],
    );

    expect(seen).toBe("/from/flag");
    expect(process.env[CACHE_DIR_ENV]).toBe("/from/env");
    delete process.env[CACHE_DIR_ENV];
  });

  it("leaves the variable alone when there is no flag", async () => {
    process.env[CACHE_DIR_ENV] = "/from/env";

    const seen = await withCacheDir(
      undefined,
      async () => process.env[CACHE_DIR_ENV],
    );

    expect(seen).toBe("/from/env");
    delete process.env[CACHE_DIR_ENV];
  });

  it("removes the variable it set, even when the run throws", async () => {
    delete process.env[CACHE_DIR_ENV];

    await expect(
      withCacheDir("/from/flag", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(process.env[CACHE_DIR_ENV]).toBeUndefined();
  });
});
