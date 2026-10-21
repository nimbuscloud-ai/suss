/**
 * The cache key's code hash, checked against the built packages. A case
 * starts where a run starts, at an adapter's bundle or a pack's entry,
 * copies the files the hash reads, and edits one package's files the way
 * a rebuild would. The hash has to change for every package it reaches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { createCodeHasher } from "@suss/extractor";

// Where a run starts, and packages the code hash from there has to reach.
const STARTS: Record<string, readonly string[]> = {
  "@suss/adapter-typescript": [
    "@suss/extractor",
    "@suss/resolution",
    "@suss/values",
    "@suss/ir-core",
  ],
  "@suss/adapter-python": ["@suss/values", "@suss/sql"],
  "@suss/adapter-ruby": ["@suss/values", "@suss/sql"],
  "@suss/packs/aws-eventbridge": [
    "@suss/recognize",
    "@suss/adapter-typescript",
  ],
  "@suss/packs/aws-lambda": ["@suss/recognize", "@suss/manifest-aws"],
  "@suss/packs/graphql-ruby": ["@suss/contract-graphql"],
  "@suss/runtime-node": ["@suss/adapter-typescript"],
};

const ADAPTERS = [
  "@suss/adapter-typescript",
  "@suss/adapter-python",
  "@suss/adapter-ruby",
];

interface BuildCopy {
  root: string;
  entry: string;
  /** Each package the hash reaches, with the files copied from it. */
  packages: Map<string, string[]>;
}

function entryOf(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function packageOf(file: string): { dir: string; name: string } {
  let dir = path.dirname(file);
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    dir = path.dirname(dir);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { name: string };
  return { dir, name: manifest.name };
}

/** Copies what the hash reads into a node_modules of its own. */
function copyBuild(specifier: string): BuildCopy {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-built-")),
  );
  const packages = new Map<string, string[]>();
  const copied = createCodeHasher()
    .codeFiles(entryOf(specifier))
    .map((file) => {
      const owner = packageOf(file);
      const into = path.join(root, "node_modules", owner.name);
      const copy = path.join(into, path.relative(owner.dir, file));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(file, copy);
      fs.copyFileSync(
        path.join(owner.dir, "package.json"),
        path.join(into, "package.json"),
      );
      packages.set(owner.name, [...(packages.get(owner.name) ?? []), copy]);
      return copy;
    });
  return { root, entry: copied[0] ?? "", packages };
}

function hashAfterRebuilding(copy: BuildCopy, name: string): string {
  const files = copy.packages.get(name) ?? [];
  const before = files.map((file) => fs.readFileSync(file));
  for (const file of files) {
    fs.appendFileSync(file, "\n// rebuilt\n");
  }
  try {
    return createCodeHasher().codeHash(copy.entry);
  } finally {
    files.forEach((file, at) => {
      fs.writeFileSync(file, before[at] ?? "");
    });
  }
}

function declaredSussDependencies(name: string): string[] {
  const found = new Set<string>();
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(packageOf(entryOf(next)).dir, "package.json"),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@suss/") || found.has(dependency)) {
        continue;
      }
      found.add(dependency);
      pending.push(dependency);
    }
  }
  return [...found];
}

describe.each(Object.keys(STARTS))("the code hash from %s", (specifier) => {
  const copy = copyBuild(specifier);
  const built = createCodeHasher().codeHash(copy.entry);

  afterAll(() => {
    fs.rmSync(copy.root, { recursive: true, force: true });
  });

  it("reads the same code in the copy as in the build", () => {
    expect(built).not.toBe("");
    expect(built).toBe(createCodeHasher().codeHash(entryOf(specifier)));
  });

  it("reaches the packages its summaries depend on", () => {
    expect([...copy.packages.keys()]).toEqual(
      expect.arrayContaining([...(STARTS[specifier] ?? [])]),
    );
  });

  it.each([...copy.packages.keys()])("changes when %s is rebuilt", (name) => {
    expect(hashAfterRebuilding(copy, name)).not.toBe(built);
  });
});

describe.each(ADAPTERS)("the code hash of %s", (adapter) => {
  it("reaches every suss package the adapter depends on", () => {
    const reached = createCodeHasher()
      .codeFiles(entryOf(adapter))
      .map((file) => packageOf(file).name);

    expect(reached).toEqual(
      expect.arrayContaining(declaredSussDependencies(adapter)),
    );
  });
});
