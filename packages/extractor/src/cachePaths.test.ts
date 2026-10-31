import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { documentPieces } from "@suss/behavioral-ir/files";

import { PATHS_AS_THEY_ARE, storedPathsFor } from "./cachePaths.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cache-paths-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What a checkout at `root` reads back from text another checkout stored. */
function readAt(root: string, text: string): unknown {
  const file = path.join(dir, "stored.json");
  fs.writeFileSync(file, text);
  return storedPathsFor(root, root).read(file);
}

describe("storedPathsFor", () => {
  const value = {
    file: "/work/a/src/x.ts",
    deps: ["/work/a/src/y.ts", "/work/a"],
    key: "/work/a/src/x.ts:20-80",
    message: "read /work/a/src/z.ts first",
    sibling: "/work/a-old/src/x.ts",
    inside: "/home/work/a/src/x.ts",
  };
  /** The same value as a checkout at /work/b reads it back. */
  const valueInB = {
    file: "/work/b/src/x.ts",
    deps: ["/work/b/src/y.ts", "/work/b"],
    key: "/work/b/src/x.ts:20-80",
    message: "read /work/b/src/z.ts first",
    sibling: "/work/a-old/src/x.ts",
    inside: "/home/work/a/src/x.ts",
  };

  it("stores the same text for the same files in two checkouts", () => {
    const fromA = storedPathsFor("/work/a", "/work/a").storedPiece(
      JSON.stringify(value),
    );
    const fromB = storedPathsFor("/work/b", "/work/b").storedPiece(
      JSON.stringify({
        ...value,
        file: "/work/b/src/x.ts",
        deps: ["/work/b/src/y.ts", "/work/b"],
        key: "/work/b/src/x.ts:20-80",
        message: "read /work/b/src/z.ts first",
      }),
    );

    expect(fromA).toBe(fromB);
    expect(fromA).not.toContain('"/work/a/');
    expect(fromA).not.toContain('"/work/a"');
  });

  it("reads another checkout's paths back as its own", () => {
    const stored = storedPathsFor("/work/a", "/work/a").storedPiece(
      JSON.stringify(value),
    );

    expect(readAt("/work/b", stored)).toEqual(valueInB);
  });

  it("reads a percent-encoded path, as a key on a subclass has, back as its own", () => {
    const key = `/work/a/src/repo.py:10-20#on=Users@${encodeURIComponent("/work/a/src/users.py")}`;
    const stored = storedPathsFor("/work/a", "/work/a").storedPiece(
      JSON.stringify({ key }),
    );

    expect(stored).not.toContain("work");
    expect(readAt("/work/b", stored)).toEqual({
      key: `/work/b/src/repo.py:10-20#on=Users@${encodeURIComponent("/work/b/src/users.py")}`,
    });
  });

  it("reads a path after an escape in JSON text, as an id with NULs between its parts has", () => {
    const value = {
      id: "router 0/0\u0000/work/a/src/routes.py\u0000router",
      lines: "first\n/work/a/src/x.py",
    };
    const stored = storedPathsFor("/work/a", "/work/a").storedPiece(
      JSON.stringify(value),
    );

    expect(stored).not.toContain("work/a");
    expect(readAt("/work/b", stored)).toEqual({
      id: "router 0/0\u0000/work/b/src/routes.py\u0000router",
      lines: "first\n/work/b/src/x.py",
    });
  });

  it("reads back a file written one line per element, as the cache writes them", () => {
    const stored = [...documentPieces(value)]
      .map(storedPathsFor("/work/a", "/work/a").storedPiece)
      .join("");

    expect(stored.split("\n").length).toBeGreaterThan(2);
    expect(readAt("/work/b", stored)).toEqual(valueInB);
  });

  it("keeps each spelling of a root reached through a symlink", () => {
    const paths = storedPathsFor("/private/tmp/a", "/tmp/a");
    const stored = paths.storedPiece(
      JSON.stringify(["/tmp/a/x.ts", "/private/tmp/a/y.ts"]),
    );
    const file = path.join(dir, "stored.json");
    fs.writeFileSync(file, stored);

    expect(stored).not.toContain("tmp/a");
    expect(storedPathsFor("/private/tmp/b", "/tmp/b").read(file)).toEqual([
      "/tmp/b/x.ts",
      "/private/tmp/b/y.ts",
    ]);
  });

  it("writes the root as a placeholder in a key, wherever a path ends", () => {
    const keyA = storedPathsFor("/work/a", "/work/a").keyText;
    const keyB = storedPathsFor("/work/b", "/work/b").keyText;

    expect(keyA("projectRoot=/work/a,importRoots=/work/a/src:/opt/lib")).toBe(
      keyB("projectRoot=/work/b,importRoots=/work/b/src:/opt/lib"),
    );
    expect(keyA("/work/a/tsconfig.json|ws:1")).toBe(
      keyB("/work/b/tsconfig.json|ws:1"),
    );
    expect(keyA("projectRoot=/work/a")).not.toContain("/work/a");
  });

  it("leaves paths alone outside a checkout", () => {
    const file = path.join(dir, "stored.json");
    fs.writeFileSync(file, JSON.stringify(value));

    expect(PATHS_AS_THEY_ARE.storedPiece("/work/a/x")).toBe("/work/a/x");
    expect(PATHS_AS_THEY_ARE.keyText("/work/a/x")).toBe("/work/a/x");
    expect(PATHS_AS_THEY_ARE.read(file)).toEqual(value);
  });
});
