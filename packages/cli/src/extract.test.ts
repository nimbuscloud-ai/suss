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
  relativizeRenderTargets,
  relativizeSummaryPaths,
  resolveFramework,
  resolvePythonPack,
  resolveRubyPack,
} from "./extract.js";
import { stubOverlayOf } from "./stubs.js";

import type { CacheDiagnostic } from "@suss/adapter-typescript";
import type { BehavioralSummary, RenderNode } from "@suss/behavioral-ir";
import type { Language } from "./language.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const pythonFixture = path.join(repoRoot, "fixtures", "python-webapp");
const rubyFixture = path.join(repoRoot, "fixtures", "ruby-graphql");

function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pack-config-"));
  const file = path.join(dir, "pack.json");
  fs.writeFileSync(file, contents);
  return file;
}

// These packs refuse to run without per-project config, since only the
// project can say what its layout is or which database it talks to.
const CONFIG_FOR: Record<string, unknown> = {
  "graphql-ruby": { root: "app/graphql" },
  sqlalchemy: { storageSystem: "postgresql" },
  activerecord: { storageSystem: "postgresql" },
};

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

  it("takes a scoped name, which is the only way to reach a pack outside the framework- prefix", async () => {
    const pack = await resolveFramework("@suss/runtime-node");
    expect(pack.name.length).toBeGreaterThan(0);
  });

  it("hands a pack the config the flag names", async () => {
    const file = writeConfig(
      JSON.stringify({ requiresImport: ["@acme/signing"] }),
    );
    const pack = await resolveFramework(`aws-dynamodb=${file}`);
    expect(pack.requiresImport).toContain("@acme/signing");
  });

  it("stamps a configured pack with a version the config changes", async () => {
    const gate = (module: string) =>
      JSON.stringify({ requiresImport: [module] });

    const plain = await resolveFramework("aws-dynamodb");
    const configured = await resolveFramework(
      `aws-dynamodb=${writeConfig(gate("@acme/signing"))}`,
    );
    const other = await resolveFramework(
      `aws-dynamodb=${writeConfig(gate("@acme/ledger"))}`,
    );

    expect(configured.version).not.toBe(plain.version);
    expect(other.version).not.toBe(configured.version);
  });

  it("stamps a pack with a hash of the code it loaded", async () => {
    const pack = await resolveFramework("apollo-client");
    const loaded = fileURLToPath(
      import.meta.resolve("@suss/packs/apollo-client"),
    );

    expect(pack.version).toContain(computeContentHash([loaded]));
    expect(pack.version).not.toContain(
      computeContentHash([
        fileURLToPath(import.meta.resolve("@suss/packs/fetch")),
      ]),
    );
  });

  it("gives two packs resolved in one process their own code hash", async () => {
    const apollo = await resolveFramework("apollo-client");
    const web = await resolveFramework("fetch");

    expect(apollo.version).toContain(
      computeContentHash([
        fileURLToPath(import.meta.resolve("@suss/packs/apollo-client")),
      ]),
    );
    expect(web.version).toContain(
      computeContentHash([
        fileURLToPath(import.meta.resolve("@suss/packs/fetch")),
      ]),
    );
  });

  it("keeps the config in the stamp alongside the code", async () => {
    const configured = await resolveFramework(
      `aws-dynamodb=${writeConfig('{"requiresImport":["@acme/signing"]}')}`,
    );
    const plain = await resolveFramework("aws-dynamodb");
    const loaded = fileURLToPath(
      import.meta.resolve("@suss/packs/aws-dynamodb"),
    );
    const code = computeContentHash([loaded]);

    expect(plain.version).toContain(code);
    expect(configured.version).toContain(code);
    expect(configured.version).not.toBe(plain.version);
  });

  it("stamps the same config the same way whatever order it is written in", async () => {
    const one = await resolveFramework(
      `prisma=${writeConfig('{"storageSystem":"mysql","scope":"reporting"}')}`,
    );
    const two = await resolveFramework(
      `prisma=${writeConfig('{"scope":"reporting","storageSystem":"mysql"}')}`,
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

    // The dynamic fallback would load a pack missing from the record, so ask
    // the record itself.
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

    // Every built-in is a subpath of the one package the CLI depends
    // on, so the check is that the subpath resolves rather than that
    // each pack is its own dependency.
    for (const [name, specifier] of Object.entries(BUILTIN_FRAMEWORKS)) {
      expect(
        { name, declared: specifier.startsWith("@suss/packs/") },
        `-f ${name} names ${specifier}`,
      ).toEqual({ name, declared: true });
      expect(() => import.meta.resolve(specifier)).not.toThrow();
    }
    expect("@suss/packs" in manifest.dependencies).toBe(true);

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

  it("hands a Python pack the wrapper modules a stub states", async () => {
    const overlay = stubOverlayOf([
      {
        package: "myapp.wrappers.restx",
        statements: [{ kind: "re-exports", of: "flask_restx" }],
      },
    ]);
    const pack = await resolvePythonPack("flask-restx", overlay);
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

  it("refuses a key the pack does not take, by name", async () => {
    const file = writeConfig(
      JSON.stringify({
        registrationHelpes: [{ helperName: "mountHealth" }],
        nonsense: 42,
      }),
    );
    await expect(resolveFramework(`hono=${file}`)).rejects.toThrow(
      /"registrationHelpes", "nonsense" are not options this pack takes/,
    );
  });

  it("names the config file and what the pack does take, leaving out the stub-only keys", async () => {
    const file = writeConfig(JSON.stringify({ nonsense: 42 }));
    const failure = resolveFramework(`nestjs-microservices=${file}`);
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(
      /The nestjs-microservices pack takes: transport\./,
    );
  });

  it("says a pack takes nothing from a config file when every option it has is stub-only", async () => {
    const file = writeConfig(JSON.stringify({ nonsense: 42 }));
    await expect(resolveFramework(`nestjs-rest=${file}`)).rejects.toThrow(
      /The nestjs-rest pack does not take any option from a config file\./,
    );
  });

  it("refuses a storage system the checker could not pair, and says which are allowed", async () => {
    const file = writeConfig(JSON.stringify({ storageSystem: "postgres" }));
    await expect(resolveFramework(`prisma=${file}`)).rejects.toThrow(
      /storageSystem has to be one of "postgresql", "mysql", "sqlite"/,
    );
  });

  it("takes a config every key of which the pack declares", async () => {
    const file = writeConfig(
      JSON.stringify({ storageSystem: "mysql", scope: "reporting" }),
    );
    const pack = await resolveFramework(`prisma=${file}`);
    expect(pack.name).toBe("prisma");
  });

  it("refuses an option a dependency stub states, and says where it goes", async () => {
    const file = writeConfig(
      JSON.stringify({ classDecorators: ["ApiController"] }),
    );
    const failure = resolveFramework(`nestjs-rest=${file}`);
    await expect(failure).rejects.toThrow(
      /The classDecorators option describes a dependency/,
    );
    await expect(failure).rejects.toThrow(/suss infer stub <package>/);
  });

  it("tells apart a stub-only option and a key no pack declares", async () => {
    const file = writeConfig(
      JSON.stringify({ classDecorators: [], nonsense: 42 }),
    );
    const failure = resolveFramework(`nestjs-microservices=${file}`);
    await expect(failure).rejects.toThrow(
      /The classDecorators option describes a dependency/,
    );
    await expect(failure).rejects.toThrow(
      /"nonsense" is not an option this pack takes/,
    );
  });

  /** What a run writes to stderr while resolving a pack. */
  const warningsWhileResolving = async (spec: string): Promise<string> => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await resolveFramework(spec);
    } finally {
      process.stderr.write = original;
    }
    return written.join("");
  };

  // 0.20.0 told everyone setting one of these to write a dependency
  // stub. For a helper the project wrote itself that was the wrong
  // instruction and the reading that replaces it only arrived in
  // 0.21.0, so these three are read past with a warning until 0.22.0
  // rather than refused like the nine that state a dependency fact.
  it("warns and keeps going when a config still describes a helper", async () => {
    const helper = writeConfig(
      JSON.stringify({
        registrationHelpers: [
          {
            helperName: "registerCrud",
            registrations: [
              { method: "GET", pathTemplate: "/{1}", handlerArg: "{2}.list" },
            ],
          },
        ],
      }),
    );

    const said = await warningsWhileResolving(`express=${helper}`);

    expect(said).toContain("ignores registrationHelpers");
    expect(said).toContain("reads the helper itself");
    expect(said).toContain("0.22.0");
    expect(said).not.toContain("suss infer stub");
  });

  it("warns and keeps going when a config still sets subjectFactories", async () => {
    const file = writeConfig(
      JSON.stringify({ subjectFactories: [{ property: "subject" }] }),
    );

    const said = await warningsWhileResolving(`aws-lambda=${file}`);

    expect(said).toContain("ignores subjectFactories");
    expect(said).toContain("SAM template's event source");
    expect(said).toContain("0.22.0");
    // A retired option describes the project's own code, so nothing
    // here should send somebody off to write a dependency stub.
    expect(said).not.toContain("suss infer stub");
  });

  it("still hands a pack an option a stub states", async () => {
    const overlay = stubOverlayOf([
      {
        package: "@acme/ledger-native",
        statements: [
          {
            kind: "composes-decorator",
            export: "ApiController",
            composes: { module: "@nestjs/common", name: "Controller" },
          },
        ],
      },
    ]);
    const plain = await resolveFramework("nestjs-rest");
    const stubbed = await resolveFramework("nestjs-rest", overlay);

    expect(stubbed.version).not.toBe(plain.version);
    expect(JSON.stringify(stubbed.discovery)).toContain("ApiController");
  });

  it("leaves a pack that declares no options alone", async () => {
    const file = writeConfig(JSON.stringify({ whateverItLikes: 1 }));
    const pack = await resolveFramework(`react=${file}`);
    expect(pack.name).toBe("react");
  });

  it("says what a pack needs when its required config is missing", async () => {
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
    // The wrapper module the routes import is a fact about a dependency,
    // so the project states it in a stub rather than in pack config.
    const project = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-")),
      "project",
    );
    fs.cpSync(pythonFixture, project, { recursive: true });
    fs.mkdirSync(path.join(project, "suss", "stubs"), { recursive: true });
    fs.writeFileSync(
      path.join(project, "suss", "stubs", "restx-wrapper.yaml"),
      "package: myapp.wrappers.restx\nstatements:\n  - kind: re-exports\n    of: flask_restx\n",
    );
    const out = path.join(project, "summaries.json");

    const summaries = await extract({
      dir: project,
      frameworks: ["fastapi", "flask-restx"],
      output: out,
    });

    expect(summaries.map((s) => s.identity.name).sort()).toEqual(
      [
        "TodoList.get",
        "TodoList.post",
        "OrderDetail.get",
        "OrderDetail.delete",
        "UserList.get",
        "BehaviorList.get",
        "BehaviorDetail.get",
        "InvoiceList.get",
        "InvoiceDetail.get",
        "ReportDetail.get",
        "ExportDetail.get",
        "read_item",
        "create_item",
      ].sort(),
    );
    expect(summaries.every((s) => !path.isAbsolute(s.location.file))).toBe(
      true,
    );
  });
});

describe("extract over a project with a repository checked out inside it", () => {
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
        "Organizer.displayName",
        "Organizer.phone",
        "Organizer.status",
        "Query.campaign",
        "Mutation.campaignUpdate",
      ].sort(),
    );
  });
});

describe("the note a run writes beside its summaries", () => {
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
    const root = projectMissingItsSubmodule();
    const out = path.join(root, "summaries.json");

    await extract({ dir: root, frameworks: ["fastapi"], output: out });

    const note = JSON.parse(
      fs.readFileSync(incompletenessPathFor(out), "utf8"),
    ) as { submodulesNotCheckedOut: string[] };
    expect(note.submodulesNotCheckedOut).toEqual(["libs/framework"]);
  });

  it("takes the note away once the submodule is there", async () => {
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
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-relative-"));
    fs.cpSync(path.join(rubyFixture, "app"), path.join(project, "app"), {
      recursive: true,
    });
    const config = path.join(project, "suss.graphql-ruby.json");
    fs.writeFileSync(config, JSON.stringify({ root: "app/graphql" }));

    // Run from the repository root, so the relative path resolves only if
    // it is read from the config file.
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

  it("points a recognizer-only run at a discovery pack", () => {
    const output = formatEmptyLanguageRun("python", 8, ["sqlalchemy"], true);
    expect(output).toContain("No discovery pack is loaded");
    expect(output).toContain("suss extract -f fastapi -f sqlalchemy");
  });
});

describe("extract, on a project with no boundaries", () => {
  it("returns nothing and fails the run by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-empty-"));
    fs.writeFileSync(path.join(dir, "thing.ts"), "export const x = 1;\n");
    const out = path.join(dir, "summaries.json");
    const previous = process.exitCode;

    const summaries = await extract({
      dir,
      frameworks: ["express"],
      output: out,
    });

    expect(summaries).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
  });

  it("stays green when --allow-empty opts out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-empty-"));
    fs.writeFileSync(path.join(dir, "thing.ts"), "export const x = 1;\n");
    const out = path.join(dir, "summaries.json");
    const previous = process.exitCode;

    const summaries = await extract({
      dir,
      frameworks: ["express"],
      output: out,
      allowEmpty: true,
    });

    expect(summaries).toEqual([]);
    expect(process.exitCode).toBe(previous);
    process.exitCode = previous;
  });
});

describe("parseFrameworkSpec", () => {
  it("reads a bare pack name", () => {
    expect(parseFrameworkSpec("aws-sqs")).toEqual({ name: "aws-sqs" });
  });

  it("reads the config file the spec names, and says which file it was", () => {
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

describe("relativizeSummaryPaths", () => {
  it("rewrites the unit's file, module imports, and the render tree", () => {
    const summary = {
      location: { file: "/repo/src/page.tsx", range: { start: 1, end: 2 } },
      transitions: [
        {
          output: {
            type: "render",
            component: "Page",
            root: {
              type: "element",
              tag: "Avatar",
              target: { file: "/repo/src/avatar.tsx", name: "Avatar" },
              children: [],
            },
          },
        },
        { output: { type: "return" } },
      ],
      identity: {
        name: "createOrder",
        exportPath: ["createOrder"],
        boundaryBinding: {
          transport: "http",
          semantics: {
            name: "function-call",
            module: "/repo/src/actions.ts",
            exportName: "createOrder",
          },
          recognition: "nextjs",
        },
      },
      metadata: { moduleImports: ["/repo/src/avatar.tsx"] },
    } as unknown as BehavioralSummary;

    relativizeSummaryPaths(summary, "/repo");

    expect(summary.location.file).toBe("src/page.tsx");
    expect(
      summary.identity.boundaryBinding?.semantics.name === "function-call"
        ? summary.identity.boundaryBinding.semantics.module
        : undefined,
    ).toBe("src/actions.ts");
    expect(summary.metadata?.moduleImports).toEqual(["src/avatar.tsx"]);
    const rendered = summary.transitions[0].output;
    expect(
      rendered.type === "render" && rendered.root?.type === "element"
        ? rendered.root.target?.file
        : undefined,
    ).toBe("src/avatar.tsx");
  });

  it("rewrites the file each wrapper around the unit is declared in", () => {
    const summary = {
      location: { file: "/repo/src/app.ts", range: { start: 1, end: 2 } },
      transitions: [],
      identity: { name: "get", exportPath: [], boundaryBinding: null },
      metadata: {
        wrappers: {
          applied: [
            {
              file: "/repo/src/requireCaller.ts",
              name: "requireCaller",
              scope: "/v1/*",
            },
          ],
        },
      },
    } as unknown as BehavioralSummary;

    relativizeSummaryPaths(summary, "/repo");

    expect(summary.metadata?.wrappers).toEqual({
      applied: [
        { file: "src/requireCaller.ts", name: "requireCaller", scope: "/v1/*" },
      ],
    });
  });

  it("rewrites the file on an outcome a wrapper contributed", () => {
    const summary = {
      location: { file: "/repo/src/app.ts", range: { start: 1, end: 2 } },
      transitions: [
        {
          output: { type: "return" },
          metadata: {
            wrappers: {
              from: {
                file: "/repo/src/requireCaller.ts",
                name: "requireCaller",
              },
            },
          },
        },
      ],
      identity: { name: "get", exportPath: [], boundaryBinding: null },
    } as unknown as BehavioralSummary;

    relativizeSummaryPaths(summary, "/repo");

    expect(summary.transitions[0].metadata?.wrappers).toEqual({
      from: { file: "src/requireCaller.ts", name: "requireCaller" },
    });
  });
});

describe("relativizeRenderTargets", () => {
  it("rewrites every target in the tree, conditionals included", () => {
    const root: RenderNode = {
      type: "element",
      tag: "div",
      children: [
        {
          type: "element",
          tag: "Avatar",
          target: { file: "/repo/src/avatar.tsx", name: "Avatar" },
          children: [],
        },
        {
          type: "conditional",
          condition: "ok",
          whenTrue: {
            type: "element",
            tag: "Badge",
            target: { file: "/repo/src/badge.tsx", name: "Badge" },
            children: [],
          },
          whenFalse: null,
        },
        { type: "text", value: "hi" },
      ],
    };

    relativizeRenderTargets(root, "/repo");

    const [avatar, conditional] = root.type === "element" ? root.children : [];
    expect(avatar?.type === "element" ? avatar.target?.file : undefined).toBe(
      "src/avatar.tsx",
    );
    expect(
      conditional?.type === "conditional" &&
        conditional.whenTrue.type === "element"
        ? conditional.whenTrue.target?.file
        : undefined,
    ).toBe("src/badge.tsx");
  });
});
