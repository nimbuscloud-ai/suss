import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computeContentHash } from "@suss/adapter-typescript";

import {
  BUILTIN_FRAMEWORKS,
  extract,
  formatCacheDiagnostic,
  parseFrameworkSpec,
  resolveFramework,
} from "./extract.js";

import type { CacheDiagnostic } from "@suss/adapter-typescript";

/** Write a pack config to a temp file and answer its path. */
function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pack-config-"));
  const file = path.join(dir, "pack.json");
  fs.writeFileSync(file, contents);
  return file;
}

describe("resolveFramework", () => {
  it("loads a built-in pack by the name the CLI flag takes", async () => {
    const pack = await resolveFramework("nextjs");
    expect(pack.name).toBe("nextjs");
  });

  it("says which names it knows when given one it does not", async () => {
    await expect(resolveFramework("nuxt")).rejects.toThrow(/nextjs/);
  });

  it("hands a pack the config the flag names", async () => {
    const file = writeConfig(
      JSON.stringify({
        producers: [
          {
            module: "@acme/async",
            receiver: "CommandDispatcher",
            method: "dispatch",
            subjectArg: 0,
            bodyArg: 1,
          },
        ],
      }),
    );
    const pack = await resolveFramework(`aws-sqs=${file}`);
    expect(pack.requiresImport).toContain("@acme/async");
    expect(pack.invocationRecognizers).toHaveLength(3);
  });

  it("stamps a configured pack with a version the config changes", async () => {
    const producer = (receiver: string) =>
      JSON.stringify({
        producers: [
          {
            module: "@acme/async",
            receiver,
            method: "dispatch",
            subjectArg: 0,
            bodyArg: 1,
          },
        ],
      });

    const plain = await resolveFramework("aws-sqs");
    const configured = await resolveFramework(
      `aws-sqs=${writeConfig(producer("CommandDispatcher"))}`,
    );
    const other = await resolveFramework(
      `aws-sqs=${writeConfig(producer("EventDispatcher"))}`,
    );

    expect(configured.version).not.toBe(plain.version);
    expect(other.version).not.toBe(configured.version);
  });

  it("stamps a pack with a hash of the code it loaded", async () => {
    const pack = await resolveFramework("apollo-client");
    const loaded = fileURLToPath(import.meta.resolve("@suss/client-apollo"));

    // Editing a pack has to invalidate warm caches, and the version
    // stamp is the only thing about a pack the cache key sees. Almost
    // no pack declares a version, so without the hash of what was
    // loaded, a pack edit would be answered from the previous code.
    expect(pack.version).toContain(computeContentHash([loaded]));
    expect(pack.version).not.toContain(
      computeContentHash([
        fileURLToPath(import.meta.resolve("@suss/client-web")),
      ]),
    );
  });

  it("gives two packs resolved in one process their own code hash", async () => {
    // One hash per pack is kept for the life of the process, so a
    // second pack must not be answered with the first pack's hash.
    const apollo = await resolveFramework("apollo-client");
    const web = await resolveFramework("fetch");

    expect(apollo.version).toContain(
      computeContentHash([
        fileURLToPath(import.meta.resolve("@suss/client-apollo")),
      ]),
    );
    expect(web.version).toContain(
      computeContentHash([
        fileURLToPath(import.meta.resolve("@suss/client-web")),
      ]),
    );
  });

  it("keeps the config in the stamp alongside the code", async () => {
    const configured = await resolveFramework(
      `aws-sqs=${writeConfig('{"producers":[{"module":"@acme/async","receiver":"CommandDispatcher","method":"dispatch","subjectArg":0}]}')}`,
    );
    const plain = await resolveFramework("aws-sqs");
    const loaded = fileURLToPath(
      import.meta.resolve("@suss/framework-aws-sqs"),
    );
    const code = computeContentHash([loaded]);

    expect(plain.version).toContain(code);
    expect(configured.version).toContain(code);
    expect(configured.version).not.toBe(plain.version);
  });

  it("stamps the same config the same way whatever order it is written in", async () => {
    const one = await resolveFramework(
      `aws-sqs=${writeConfig('{"producers":[{"module":"@acme/async","receiver":"D","method":"send","subjectArg":0}]}')}`,
    );
    const two = await resolveFramework(
      `aws-sqs=${writeConfig('{"producers":[{"subjectArg":0,"method":"send","receiver":"D","module":"@acme/async"}]}')}`,
    );

    expect(two.version).toBe(one.version);
  });

  it("names every framework pack the CLI ships with, and loads each", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };

    const shipped = Object.keys(manifest.dependencies)
      .filter((dep) => dep.startsWith("@suss/framework-"))
      .map((dep) => dep.slice("@suss/framework-".length))
      .sort();

    // The dynamic fallback would load a pack that is missing from the
    // record, so ask the record itself rather than asking whether the
    // name resolves.
    expect(shipped.filter((name) => name in BUILTIN_FRAMEWORKS)).toEqual(
      shipped,
    );

    const packs = await Promise.all(shipped.map(resolveFramework));
    for (const pack of packs) {
      expect(pack.name).toBeTruthy();
    }
  });

  it("points every name it takes at a package the CLI depends on", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };

    // The record holds package names as plain strings, so a typo or a
    // pack that stopped being a dependency reaches the user as a failed
    // run rather than a failed build. Four of these names sit outside
    // the `@suss/framework-` family the test above walks.
    for (const [name, specifier] of Object.entries(BUILTIN_FRAMEWORKS)) {
      expect(
        { name, declared: specifier in manifest.dependencies },
        `-f ${name} names ${specifier}`,
      ).toEqual({ name, declared: true });
    }

    const packs = await Promise.all(
      Object.keys(BUILTIN_FRAMEWORKS).map(resolveFramework),
    );
    expect(packs.map((pack) => pack.name).filter(Boolean)).toHaveLength(
      Object.keys(BUILTIN_FRAMEWORKS).length,
    );
  });
});

describe("extract, on a project with no boundaries", () => {
  it("returns nothing and fails the run when asked to", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-empty-"));
    fs.writeFileSync(path.join(dir, "thing.ts"), "export const x = 1;\n");
    const out = path.join(dir, "summaries.json");
    const previous = process.exitCode;

    const summaries = await extract({
      dir,
      frameworks: ["express"],
      output: out,
      failOnEmpty: true,
    });

    expect(summaries).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
  });
});

describe("parseFrameworkSpec", () => {
  it("reads a bare pack name", () => {
    expect(parseFrameworkSpec("aws-sqs")).toEqual({ name: "aws-sqs" });
  });

  it("reads the config file the spec names", () => {
    const file = writeConfig(JSON.stringify({ producers: [] }));
    expect(parseFrameworkSpec(`aws-sqs=${file}`)).toEqual({
      name: "aws-sqs",
      options: { producers: [] },
    });
  });

  it("says where it looked when the config is missing", () => {
    expect(() => parseFrameworkSpec("aws-sqs=./nowhere.json")).toThrow(
      /No pack config at/,
    );
  });

  it("says so when the config is not JSON", () => {
    const file = writeConfig("producers: []");
    expect(() => parseFrameworkSpec(`aws-sqs=${file}`)).toThrow(/is not JSON/);
  });
});

describe("formatCacheDiagnostic", () => {
  it("renders a hit", () => {
    const out = formatCacheDiagnostic({ kind: "hit" });
    expect(out).toContain("hit");
  });

  it("renders a miss with no manifest", () => {
    const out = formatCacheDiagnostic({
      kind: "miss",
      missReason: "no-manifest",
    });
    expect(out).toContain("miss");
    expect(out).toContain("no-manifest");
  });

  it("renders a miss on a changed file", () => {
    const diag: CacheDiagnostic = {
      kind: "miss",
      missReason: "files-changed",
    };
    expect(formatCacheDiagnostic(diag)).toContain("files-changed");
  });

  it("names the reason a key that moved missed", () => {
    const out = formatCacheDiagnostic({
      kind: "miss",
      missReason: "key-changed",
    });
    expect(out).toContain("key-changed");
  });
});
