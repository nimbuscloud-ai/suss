/**
 * The digest that identifies an adapter and its packs in a cache key.
 *
 * These tests run from source, where there is no bundle to hash, so the
 * stamp records the mode instead. What they pin down is the part that
 * must not move: the same packs in any order produce the same digest,
 * and a pack without a version is recorded as such rather than dropped.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_VERSION,
  adapterCodeStamp,
  computeAdapterPacksDigest,
  computeContentHash,
  computeDistHashFrom,
} from "./version.js";

describe("computeAdapterPacksDigest", () => {
  it("names the adapter and every pack", () => {
    expect(
      computeAdapterPacksDigest([{ name: "express", version: "1.2.0" }]),
    ).toBe(`adapter@${ADAPTER_VERSION}+source|express@1.2.0`);
  });

  it("does not care what order the packs arrive in", () => {
    const forwards = computeAdapterPacksDigest([
      { name: "express", version: "1.0.0" },
      { name: "react", version: "2.0.0" },
    ]);
    const backwards = computeAdapterPacksDigest([
      { name: "react", version: "2.0.0" },
      { name: "express", version: "1.0.0" },
    ]);
    expect(forwards).toBe(backwards);
  });

  it("says when a pack declared no version", () => {
    expect(computeAdapterPacksDigest([{ name: "local" }])).toContain(
      "local@unset",
    );
  });

  it("answers the same thing twice", () => {
    const packs = [{ name: "express", version: "1.0.0" }];
    expect(computeAdapterPacksDigest(packs)).toBe(
      computeAdapterPacksDigest(packs),
    );
  });
});

describe("adapterCodeStamp", () => {
  it("says source when nothing can find a bundle to hash", () => {
    expect(adapterCodeStamp()).toEqual({ kind: "source" });
  });

  it("answers the same thing twice", () => {
    expect(adapterCodeStamp()).toBe(adapterCodeStamp());
  });
});

describe("computeContentHash", () => {
  it("changes when a file changes", () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "pack-")),
      "pack.js",
    );
    writeFileSync(file, "one");
    const before = computeContentHash([file]);
    writeFileSync(file, "two");
    expect(computeContentHash([file])).not.toBe(before);
  });

  it("answers the same for the same files", () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "pack-")),
      "pack.js",
    );
    writeFileSync(file, "same");
    expect(computeContentHash([file])).toBe(computeContentHash([file]));
  });

  it("tells two files apart by what is in them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pack-"));
    writeFileSync(path.join(dir, "one.js"), "one");
    writeFileSync(path.join(dir, "two.js"), "two");
    expect(computeContentHash([path.join(dir, "one.js")])).not.toBe(
      computeContentHash([path.join(dir, "two.js")]),
    );
  });

  it("answers empty when it was given nothing to hash", () => {
    expect(computeContentHash([])).toBe("");
  });

  it("answers empty when a file is not there to read", () => {
    expect(
      computeContentHash([path.join(tmpdir(), "suss-absent-file.js")]),
    ).toBe("");
  });
});

describe("computeDistHashFrom", () => {
  it("answers empty for a directory with no bundle in it", () => {
    expect(computeDistHashFrom(mkdtempSync(path.join(tmpdir(), "no-")))).toBe(
      "",
    );
  });

  it("changes when the bundle changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
    writeFileSync(path.join(dir, "index.js"), "one");
    const first = computeDistHashFrom(dir);
    writeFileSync(path.join(dir, "index.js"), "two");
    const second = computeDistHashFrom(dir);
    expect(first).not.toBe("");
    expect(first).not.toBe(second);
  });

  it("answers empty for a bundle it can see but cannot read", () => {
    // A bundle it cannot read used to throw, and the caller turned that
    // into the empty stamp one level up. Returning empty from here gets
    // the caller to the same place.
    const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
    mkdirSync(path.join(dir, "index.js"));

    expect(computeDistHashFrom(dir)).toBe("");
  });

  it("answers the same for the same bundle", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
    writeFileSync(path.join(dir, "index.js"), "same");
    expect(computeDistHashFrom(dir)).toBe(computeDistHashFrom(dir));
  });
});
