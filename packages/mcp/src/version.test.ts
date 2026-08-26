import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { UNKNOWN_VERSION, versionFrom } from "./version.js";

describe("versionFrom", () => {
  it("reads the version this package ships at", () => {
    const manifest = new URL("../package.json", import.meta.url);
    const declared = (
      JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }
    ).version;

    expect(versionFrom(manifest)).toBe(declared);
    // The bug this replaced: npm_package_version is unset when a host
    // starts the binary, and every client was told 0.0.0-dev.
    expect(versionFrom(manifest)).not.toBe("0.0.0-dev");
  });

  it("says it does not know, rather than refusing to start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-version-"));
    const missing = new URL(`file://${path.join(dir, "package.json")}`);

    expect(versionFrom(missing)).toBe(UNKNOWN_VERSION);

    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(versionFrom(missing)).toBe(UNKNOWN_VERSION);

    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    expect(versionFrom(missing)).toBe(UNKNOWN_VERSION);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
