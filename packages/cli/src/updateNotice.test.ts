import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installedVersion } from "./updateNotice.js";

describe("the update notice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(path.join(os.tmpdir(), "suss-update-check.json"), {
      force: true,
    });
  });

  it("knows which version is installed", () => {
    expect(installedVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("isBehind", () => {
  it("says behind only when the registry version is ahead", async () => {
    const { isBehind } = await import("./updateNotice.js");
    expect(isBehind("0.5.3", "0.5.6")).toBe(true);
    expect(isBehind("0.5.6", "0.5.6")).toBe(false);
    expect(isBehind("0.6.0", "0.5.9")).toBe(false);
    expect(isBehind("0.5.6", "1.0.0")).toBe(true);
    expect(isBehind("0.5.6-0", "0.5.6")).toBe(false);
  });
});

describe("when nobody is there to read it", () => {
  it("fetches nothing in CI", async () => {
    const { printUpdateNoticeIfBehind } = await import("./updateNotice.js");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("CI", "1");
    await printUpdateNoticeIfBehind();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("the whole path, with the registry stubbed", () => {
  it("prints one line when the registry is ahead, and remembers the answer", async () => {
    const { printUpdateNoticeIfBehind } = await import("./updateNotice.js");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "99.0.0" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const hadTty = process.stderr.isTTY;
    process.stderr.isTTY = true;
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    const hadCi = process.env.CI;
    delete process.env.CI;
    try {
      await printUpdateNoticeIfBehind();
      await printUpdateNoticeIfBehind();
    } finally {
      writeSpy.mockRestore();
      process.stderr.isTTY = hadTty;
      if (hadCi !== undefined) {
        process.env.CI = hadCi;
      }
    }
    expect(writes.join("")).toContain("99.0.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the registry cannot be reached", async () => {
    const { printUpdateNoticeIfBehind } = await import("./updateNotice.js");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const hadTty = process.stderr.isTTY;
    process.stderr.isTTY = true;
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const hadCi = process.env.CI;
    delete process.env.CI;
    try {
      await printUpdateNoticeIfBehind();
    } finally {
      writeSpy.mockRestore();
      process.stderr.isTTY = hadTty;
      if (hadCi !== undefined) {
        process.env.CI = hadCi;
      }
    }
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
