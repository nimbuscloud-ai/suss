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
  formatEmptyLanguageRun,
  incompletenessPathFor,
  languageOfPack,
  languageOfRun,
  parseFrameworkSpec,
  resolveFramework,
  resolvePythonPack,
  resolveRubyPack,
} from "./extract.js";

import type { CacheDiagnostic } from "@suss/adapter-typescript";
import type { Language } from "./language.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const pythonFixture = path.join(repoRoot, "fixtures", "python-webapp");
const rubyFixture = path.join(repoRoot, "fixtures", "ruby-graphql");

/** Write a pack config to a temp file and answer its path. */
function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pack-config-"));
  const file = path.join(dir, "pack.json");
  fs.writeFileSync(file, contents);
  return file;
}

/**
 * The per-project config a shipped pack refuses to run without, so a
 * test that walks every pack can still load that one. graphql-ruby is
 * the only pack with one today; a directory layout is something only a
 * project can state.
 */
const CONFIG_FOR: Record<string, unknown> = {
  "graphql-ruby": { root: "app/graphql" },
};

/**
 * Load a pack by name whichever language it reads, so a test can walk
 * the whole built-in list without knowing which adapter each belongs
 * to.
 */
async function loadAnyPack(name: string): Promise<{ name: string }> {
  const config = CONFIG_FOR[name];
  const spec =
    config === undefined
      ? name
      : `${name}=${writeConfig(JSON.stringify(config))}`;

  const resolve: Record<Language, (spec: string) => Promise<{ name: string }>> =
    {
      typescript: resolveFramework,
      python: resolvePythonPack,
      ruby: resolveRubyPack,
    };
  return await resolve[languageOfPack(name)](spec);
}

describe("resolveFramework", () => {
  it("loads a built-in pack by the name the CLI flag takes", async () => {
    const pack = await resolveFramework("nextjs");
    expect(pack.name).toBe("nextjs");
  });

  it("says which names it knows when given one it does not", async () => {
    await expect(resolveFramework("nuxt")).rejects.toThrow(/nextjs/);
  });

  it("names what it tried to import", async () => {
    await expect(resolveFramework("nuxt")).rejects.toThrow(
      /@suss\/framework-nuxt/,
    );
  });

  it("takes a scoped name as the package to import", async () => {
    // The effect packs ship outside the framework- prefix, so a short
    // name cannot reach them and the full one has to work.
    const pack = await resolveFramework("@suss/runtime-node");
    expect(pack.name.length).toBeGreaterThan(0);
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

    const packs = await Promise.all(shipped.map(loadAnyPack));
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
      Object.keys(BUILTIN_FRAMEWORKS).map(loadAnyPack),
    );
    expect(packs.map((pack) => pack.name).filter(Boolean)).toHaveLength(
      Object.keys(BUILTIN_FRAMEWORKS).length,
    );
  });
});

describe("packs for the other two languages", () => {
  it("loads a Python pack through the Python adapter's own resolver", async () => {
    const pack = await resolvePythonPack("fastapi");
    expect(pack.name).toBe("fastapi");
    expect(pack.discovery.length).toBeGreaterThan(0);
  });

  it("hands a Python pack the wrapper modules the config names", async () => {
    const file = writeConfig(
      JSON.stringify({ wrapperModules: ["myapp.wrappers.restx"] }),
    );
    const pack = await resolvePythonPack(`flask-restx=${file}`);
    const pattern = pack.discovery[0];
    expect(pattern?.importModule).toContain("myapp.wrappers.restx");
  });

  it("refuses a Python pack in a TypeScript run, and says where it belongs", async () => {
    await expect(resolveFramework("fastapi")).rejects.toThrow(
      /reads Python.*--lang python/s,
    );
  });

  it("refuses a TypeScript pack in a Ruby run", async () => {
    await expect(resolveRubyPack("express")).rejects.toThrow(
      /reads TypeScript/,
    );
  });

  it("says what a pack needs when its required config is missing", async () => {
    // The pack states what it cannot work without; the CLI adds how to
    // supply one. Neither half is useful alone.
    await expect(resolveRubyPack("graphql-ruby")).rejects.toThrow(
      /needs `root`[\s\S]*-f graphql-ruby=<config.json>/,
    );
  });

  it("loads a Ruby pack once its config supplies the directory", async () => {
    const file = writeConfig(JSON.stringify({ root: "app/graphql" }));
    const pack = await resolveRubyPack(`graphql-ruby=${file}`);
    expect(pack.name).toBe("graphql-ruby");
  });
});

describe("languageOfRun", () => {
  it("takes the language the caller stated", () => {
    expect(languageOfRun({ lang: "ruby", frameworks: ["graphql-ruby"] })).toBe(
      "ruby",
    );
  });

  it("takes the language of the packs when they agree", () => {
    // A directory of Python inside a TypeScript repository would
    // otherwise read as TypeScript and come back empty.
    expect(languageOfRun({ frameworks: ["fastapi", "flask-restx"] })).toBe(
      "python",
    );
  });

  it("reads a directory of Python source as Python", () => {
    expect(languageOfRun({ dir: pythonFixture, frameworks: ["fastapi"] })).toBe(
      "python",
    );
  });

  it("a tsconfig settles it whatever else is around", () => {
    expect(
      languageOfRun({
        tsconfig: "tsconfig.json",
        frameworks: ["express"],
      }),
    ).toBe("typescript");
  });

  it("says so when it cannot tell", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "suss-nolang-"));
    expect(() =>
      languageOfRun({ dir: empty, frameworks: ["express"] }),
    ).toThrow(/could not tell what language/);
  });
});

describe("extract over a Python project", () => {
  it("reads every route the fixture declares, through the CLI", async () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-")),
      "summaries.json",
    );
    const config = writeConfig(
      JSON.stringify({ wrapperModules: ["myapp.wrappers.restx"] }),
    );

    const summaries = await extract({
      dir: pythonFixture,
      frameworks: ["fastapi", `flask-restx=${config}`],
      output: out,
    });

    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "TodoList.get",
        "TodoList.post",
        "OrderDetail.get",
        "OrderDetail.delete",
        "UserList.get",
        "read_item",
        "create_item",
      ].sort(),
    );
    // Paths come back relative to the project, the same as a
    // TypeScript run's do, so the file is portable.
    expect(summaries.every((s) => !path.isAbsolute(s.location.file))).toBe(
      true,
    );
  });
});

describe("extract over a project with a repository checked out inside it", () => {
  /** A project holding a copy of the Python fixture, plus one vendored. */
  function projectWithVendoredRepository(): { root: string; vendored: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-vendored-"));
    fs.cpSync(path.join(pythonFixture, "myapp"), path.join(root, "myapp"), {
      recursive: true,
    });

    const vendored = path.join(root, "vendor", "someone-elses-service");
    fs.mkdirSync(vendored, { recursive: true });
    fs.writeFileSync(
      path.join(vendored, ".git"),
      "gitdir: ../../.git/modules\n",
    );
    fs.cpSync(path.join(pythonFixture, "myapp"), path.join(vendored, "myapp"), {
      recursive: true,
    });
    return { root, vendored };
  }

  it("leaves a vendored repository's routes to that repository", async () => {
    // Its boundaries are not this project's to report, and nobody
    // reading this project's summaries can act on them.
    const { root } = projectWithVendoredRepository();

    const summaries = await extract({
      dir: root,
      frameworks: ["fastapi"],
      output: path.join(root, "summaries.json"),
    });

    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some((s) => s.location.file.includes("vendor"))).toBe(
      false,
    );
  });

  it("reads a submodule the project's own .gitmodules names", async () => {
    // A submodule is code this project imports, so it is this
    // project's, which is exactly what .gitmodules is there to say.
    const { root } = projectWithVendoredRepository();
    fs.writeFileSync(
      path.join(root, ".gitmodules"),
      '[submodule "vendor/someone-elses-service"]\n\tpath = vendor/someone-elses-service\n',
    );

    const summaries = await extract({
      dir: root,
      frameworks: ["fastapi"],
      output: path.join(root, "summaries.json"),
    });

    expect(summaries.some((s) => s.location.file.includes("vendor"))).toBe(
      true,
    );
  });
});

describe("extract over a Ruby project", () => {
  it("reads every field the fixture declares, through the CLI", async () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-")),
      "summaries.json",
    );
    const config = writeConfig(
      JSON.stringify({ root: path.join(rubyFixture, "app", "graphql") }),
    );

    const summaries = await extract({
      dir: rubyFixture,
      frameworks: [`graphql-ruby=${config}`],
      output: out,
    });

    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "Campaign.id",
        "Campaign.name",
        "Campaign.budget",
        "Organizer.id",
        "Organizer.email",
        "Organizer.status",
        "Query.campaign",
        "Mutation.campaignUpdate",
      ].sort(),
    );
  });
});

describe("the note a run writes beside its summaries", () => {
  /** A Python project whose shared framework submodule is empty. */
  function projectMissingItsSubmodule(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-missing-sub-"));
    fs.cpSync(path.join(pythonFixture, "myapp"), path.join(root, "myapp"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, ".gitmodules"),
      '[submodule "libs/framework"]\n\tpath = libs/framework\n',
    );
    fs.mkdirSync(path.join(root, "libs", "framework"), { recursive: true });
    return root;
  }

  it("says a Python run was incomplete when a submodule is not checked out", async () => {
    // The summaries look complete on their own. Whatever the missing
    // submodule defines is not in them and nothing in the file says so,
    // which is what a job reading the file needs to know.
    const root = projectMissingItsSubmodule();
    const out = path.join(root, "summaries.json");

    await extract({ dir: root, frameworks: ["fastapi"], output: out });

    const note = JSON.parse(
      fs.readFileSync(incompletenessPathFor(out), "utf8"),
    ) as { submodulesNotCheckedOut: string[] };
    expect(note.submodulesNotCheckedOut).toEqual(["libs/framework"]);
  });

  it("takes the note away once the submodule is there", async () => {
    // A note left behind from a previous run fails a job that has since
    // been fixed.
    const root = projectMissingItsSubmodule();
    const out = path.join(root, "summaries.json");
    await extract({ dir: root, frameworks: ["fastapi"], output: out });
    expect(fs.existsSync(incompletenessPathFor(out))).toBe(true);

    fs.writeFileSync(
      path.join(root, "libs", "framework", "api.py"),
      "def route(path): ...\n",
    );
    await extract({ dir: root, frameworks: ["fastapi"], output: out });

    expect(fs.existsSync(incompletenessPathFor(out))).toBe(false);
  });
});

describe("a pack config naming a directory", () => {
  it("reads a relative directory from the config file, not from wherever the command runs", async () => {
    // init writes exactly this config: a relative root beside the
    // project. Read against the working directory it resolves to
    // nothing from anywhere else, and every wired field comes back
    // unwired with nothing said about it.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-relative-"));
    fs.cpSync(path.join(rubyFixture, "app"), path.join(project, "app"), {
      recursive: true,
    });
    const config = path.join(project, "suss.graphql-ruby.json");
    fs.writeFileSync(config, JSON.stringify({ root: "app/graphql" }));

    // Run from the repository root, which is not the project: the
    // relative path only resolves if it is read from the config file.
    expect(process.cwd()).not.toBe(project);
    const summaries = await extract({
      dir: project,
      frameworks: [`graphql-ruby=${config}`],
      output: path.join(project, "summaries.json"),
    });

    const campaign = summaries.find(
      (s) => s.identity.name === "Query.campaign",
    );
    expect(campaign?.metadata?.graphql).toMatchObject({
      declaredContract: { returnType: { type: "ref", name: "Campaign" } },
    });
  });
});

describe("formatEmptyLanguageRun", () => {
  it("separates finding no files from finding no boundaries", () => {
    expect(formatEmptyLanguageRun("python", 0, ["fastapi"])).toContain(
      "found no Python files",
    );
    const read = formatEmptyLanguageRun("ruby", 12, ["graphql-ruby"]);
    expect(read).toContain("read 12 Ruby files");
    expect(read).toContain("graphql-ruby");
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

  it("reads the config file the spec names, and says which file it was", () => {
    // Which file it was is how a pack resolves a path written in it
    // against the file rather than against the working directory.
    const file = writeConfig(JSON.stringify({ producers: [] }));
    expect(parseFrameworkSpec(`aws-sqs=${file}`)).toEqual({
      name: "aws-sqs",
      options: { producers: [] },
      configFile: file,
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
