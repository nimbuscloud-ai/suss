import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  computeContentHash,
  createAdapterStamp,
  projectFileStamp,
  runDigest,
} from "./adapterStamp.js";

function tempModuleUrl(): { dir: string; moduleUrl: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-adapter-stamp-"));
  return {
    dir,
    moduleUrl: pathToFileURL(path.join(dir, "index.js")).toString(),
  };
}

describe("createAdapterStamp's codeStamp", () => {
  it("says source when the module's directory has no bundle in it", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    expect(stamp.codeStamp()).toEqual({ kind: "source" });
  });

  it("says bundle, with a hash, once a dist file sits beside the module", () => {
    const { dir, moduleUrl } = tempModuleUrl();
    fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};");
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    const code = stamp.codeStamp();
    expect(code.kind).toBe("bundle");
    expect(code.kind === "bundle" && code.hash.length > 0).toBe(true);
  });

  it("keeps its first answer even after the bundle on disk changes", () => {
    const { dir, moduleUrl } = tempModuleUrl();
    fs.writeFileSync(path.join(dir, "index.js"), "one");
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    const first = stamp.codeStamp();
    fs.writeFileSync(path.join(dir, "index.js"), "two");
    expect(stamp.codeStamp()).toEqual(first);
  });
});

describe("createAdapterStamp's packsDigest", () => {
  it("names the adapter and every pack", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.2.0" });
    expect(stamp.packsDigest([{ name: "express", version: "1.0.0" }])).toBe(
      "adapter@1.2.0+source|express@1.0.0",
    );
  });

  it("says when a pack declared no version", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    expect(stamp.packsDigest([{ name: "local" }])).toContain("local@unset");
  });

  it("does not care what order the packs arrive in", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    const forwards = stamp.packsDigest([
      { name: "express", version: "1.0.0" },
      { name: "react", version: "2.0.0" },
    ]);
    const backwards = stamp.packsDigest([
      { name: "react", version: "2.0.0" },
      { name: "express", version: "1.0.0" },
    ]);
    expect(forwards).toBe(backwards);
  });
});

describe("createAdapterStamp's declineWhenRunFromSource", () => {
  it("passes cacheDir through unchanged when the code stamp is a bundle", () => {
    const { dir, moduleUrl } = tempModuleUrl();
    fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};");
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    expect(stamp.declineWhenRunFromSource("/some/cache/dir")).toBe(
      "/some/cache/dir",
    );
  });

  it("declines to null when nothing can find the adapter's own code", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    expect(stamp.declineWhenRunFromSource("/some/cache/dir")).toBeNull();
  });

  it("returns null immediately when cacheDir is already null", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    expect(stamp.declineWhenRunFromSource(null)).toBeNull();
  });

  it("says why on stderr once per adapter, not once per call", () => {
    const { moduleUrl } = tempModuleUrl();
    const stamp = createAdapterStamp({ moduleUrl, version: "1.0.0" });
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    stamp.declineWhenRunFromSource("/some/cache/dir");
    stamp.declineWhenRunFromSource("/some/cache/dir");
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });
});

describe("computeContentHash", () => {
  it("changes when a file changes", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-content-")),
      "pack.js",
    );
    fs.writeFileSync(file, "one");
    const before = computeContentHash([file]);
    fs.writeFileSync(file, "two");
    expect(computeContentHash([file])).not.toBe(before);
  });

  it("answers the same for the same files", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-content-")),
      "pack.js",
    );
    fs.writeFileSync(file, "same");
    expect(computeContentHash([file])).toBe(computeContentHash([file]));
  });

  it("answers empty when it was given nothing to hash", () => {
    expect(computeContentHash([])).toBe("");
  });

  it("answers empty when a file is not there to read", () => {
    expect(
      computeContentHash([path.join(os.tmpdir(), "suss-absent-file.js")]),
    ).toBe("");
  });
});

describe("projectFileStamp", () => {
  it("changes when a project file is edited", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-")),
      "template.yaml",
    );
    fs.writeFileSync(file, "Resources: {}");
    const before = projectFileStamp([file]);
    fs.writeFileSync(file, "Resources: { Worker: {} }");
    expect(projectFileStamp([file])).not.toBe(before);
  });

  it("changes when the same content moves to another path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-"));
    fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}");
    fs.writeFileSync(path.join(dir, "template.yml"), "Resources: {}");
    expect(projectFileStamp([path.join(dir, "template.yaml")])).not.toBe(
      projectFileStamp([path.join(dir, "template.yml")]),
    );
  });

  it("does not care what order the files arrive in", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-"));
    fs.writeFileSync(path.join(dir, "one.yaml"), "one");
    fs.writeFileSync(path.join(dir, "two.yaml"), "two");
    const files = [path.join(dir, "one.yaml"), path.join(dir, "two.yaml")];
    expect(projectFileStamp(files)).toBe(
      projectFileStamp([...files].reverse()),
    );
  });

  it("tells a file that is gone from one that is there", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-")),
      "template.yaml",
    );
    const absent = projectFileStamp([file]);
    fs.writeFileSync(file, "Resources: {}");
    expect(projectFileStamp([file])).not.toBe(absent);
  });

  it("says none when no pack reads anything", () => {
    expect(projectFileStamp([])).toBe("none");
  });
});

describe("runDigest", () => {
  it("folds in none when no pack declares discoveryInputs", () => {
    expect(
      runDigest("adapter@1.0.0+source|express@1.0.0", [{}], ["a.ts"]),
    ).toBe("adapter@1.0.0+source|express@1.0.0|reads:none");
  });

  it("changes when a discovery input file changes", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-run-digest-")),
      "template.yaml",
    );
    fs.writeFileSync(file, "Resources: {}");
    const pack = { discoveryInputs: () => [file] };
    const before = runDigest("adapter@1.0.0+source", [pack], ["a.ts"]);
    fs.writeFileSync(file, "Resources: { Worker: {} }");
    expect(runDigest("adapter@1.0.0+source", [pack], ["a.ts"])).not.toBe(
      before,
    );
  });

  it("asks every pack for its discovery inputs given the same files", () => {
    const seen: (readonly string[])[] = [];
    const pack = {
      discoveryInputs: (files: readonly string[]) => {
        seen.push(files);
        return [];
      },
    };
    runDigest("adapter@1.0.0+source", [pack, pack], ["a.ts", "b.ts"]);
    expect(seen).toEqual([
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts"],
    ]);
  });
});
