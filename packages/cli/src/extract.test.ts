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
    // Two compiled send declarations, the receive recognizer, and one
    // per configured producer.
    expect(pack.invocationRecognizers).toHaveLength(4);
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
      `aws-sqs=${writeConfig('{"producers":[{"module":"@acme/async","receiver":"CommandDispatcher","method":"dispatch","subjectArg":0}]}')}`,
    );
    const plain = await resolveFramework("aws-sqs");
    const loaded = fileURLToPath(import.meta.resolve("@suss/packs/aws-sqs"));
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

  it("names the config file and what the pack does take", async () => {
    const file = writeConfig(JSON.stringify({ nonsense: 42 }));
    const failure = resolveFramework(`hono=${file}`);
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(
      /The hono pack takes: registrationHelpers\./,
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

  it("still takes a deprecated option, and still prints its note", async () => {
    const file = writeConfig(
      JSON.stringify({
        registrationHelpers: [
          {
            helperName: "mountHealth",
            registrations: [
              { method: "GET", pathTemplate: "/health", handlerArg: "{0}" },
            ],
          },
        ],
      }),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const pack = await resolveFramework(`hono=${file}`);
      expect(pack.name).toBe("hono");
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toContain("keeps working for one more release");
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
