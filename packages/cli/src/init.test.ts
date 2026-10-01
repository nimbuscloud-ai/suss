import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  declaredPacks,
  formatInitReport,
  inspectProject,
  readCommands,
  withReadableCode,
  withReadableContracts,
} from "./init.js";

import type { InitReport } from "./init.js";

/** Contract files each reader gives a summary for, since init asks the reader before it suggests one. */
const TEMPLATE =
  "Resources:\n  Orders:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      TableName: orders\n";
const OPENAPI_PATHS =
  "paths:\n  /orders:\n    get:\n      responses:\n        '200':\n          description: ok\n";
const STORY = [
  "import { Button } from './Button';",
  "export default { component: Button };",
  "export const Primary = { args: { label: 'Save' } };",
].join("\n");

describe("inspectProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-init-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(manifest: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  /**
   * The packs this project's own manifests pointed at. A TypeScript
   * project also gets the packs for what the runtime itself ships,
   * fetch and Node's own surface, which every project in the language
   * gets and which would crowd out what each test here is about.
   */
  async function names(root: string): Promise<string[]> {
    return (await inspectProject(root)).suggestions
      .filter((suggestion) => suggestion.shippedWithLanguage !== true)
      .map((s) => s.name)
      .sort();
  }

  it("picks a framework pack out of dependencies", async () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    expect(await names(dir)).toEqual(["hono"]);
  });

  it("offers a Swagger 2.0 document, which a project names swagger.json", async () => {
    writeManifest({});
    fs.writeFileSync(
      path.join(dir, "swagger.json"),
      JSON.stringify({
        swagger: "2.0",
        paths: { "/orders": { get: { responses: { "200": {} } } } },
      }),
    );
    expect(await names(dir)).toContain("openapi");
  });

  it("suggests the Next.js pack for a Next.js project", async () => {
    writeManifest({ dependencies: { next: "^15.0.0" } });
    expect(await names(dir)).toEqual(["nextjs"]);
  });

  it("reads devDependencies too, which is where the Lambda types live", async () => {
    writeManifest({ devDependencies: { "@types/aws-lambda": "^8.10.0" } });
    expect(await names(dir)).toEqual(["aws-lambda"]);
  });

  it("picks a client pack as well as a framework", async () => {
    writeManifest({
      dependencies: { express: "^4.0.0", axios: "^1.0.0" },
    });
    expect(await names(dir)).toEqual(["axios", "express"]);
  });

  it("finds a contract source on disk", async () => {
    writeManifest({ dependencies: {} });
    fs.writeFileSync(path.join(dir, "template.yaml"), TEMPLATE);
    const report = await inspectProject(dir);
    expect(await names(dir)).toEqual(["cloudformation"]);
    const contract = report.suggestions.find((s) => s.kind === "contract");
    expect(contract?.file).toBe("template.yaml");
  });

  it("offers the packs for what the runtime itself ships", async () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    const report = await inspectProject(dir);
    const shipped = report.suggestions
      .filter((suggestion) => suggestion.shippedWithLanguage === true)
      .map((s) => s.name)
      .sort();
    expect(shipped).toEqual(["fetch", "node"]);
  });

  it("sets up a project whose only client is fetch, once a file calls it", async () => {
    writeManifest({ name: "web" });
    fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "lib", "orders.js"),
      "export const load = () => window.fetch(`/api/orders`);\n",
    );

    const report = await inspectProject(dir);
    expect(declaredPacks(report).map((s) => s.name)).toEqual(["fetch"]);
    expect(report.suggestions.find((s) => s.name === "fetch")?.because).toBe(
      `fetch is called in ${path.join("src", "lib", "orders.js")}`,
    );
    expect(formatInitReport(report)).toContain(
      "suss extract -f fetch -f node -o summaries/code.json",
    );
  });

  it("leaves out the packs the language ships when nothing calls them", async () => {
    writeManifest({ name: "tooling" });
    fs.writeFileSync(
      path.join(dir, "build.ts"),
      "const refetch = () => api.fetch('x');\nrefetch();\n",
    );

    const report = await inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(declaredPacks(report)).toEqual([]);
  });

  it("does not count a call a test makes", async () => {
    writeManifest({ name: "tooling" });
    fs.mkdirSync(path.join(dir, "e2e-tests"));
    fs.writeFileSync(
      path.join(dir, "e2e-tests", "login.ts"),
      "await fetch('/login');\n",
    );
    fs.writeFileSync(
      path.join(dir, "rules.test.mjs"),
      "await fetch('/rules');\n",
    );

    expect(declaredPacks(await inspectProject(dir))).toEqual([]);
  });

  it("does not count a call inside a folder that is a project of its own", async () => {
    writeManifest({ name: "root" });
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "web", "api.ts"), "fetch('/orders');\n");

    expect(declaredPacks(await inspectProject(dir))).toEqual([]);
  });

  it("finds an OpenAPI document named after the product by its version line", async () => {
    writeManifest({});
    fs.mkdirSync(path.join(dir, "api", "openapi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "api", "openapi", "orders.yaml"),
      `# The orders API.\n\nopenapi: 3.0.1\ninfo:\n  title: Orders\n${OPENAPI_PATHS}`,
    );
    fs.writeFileSync(
      path.join(dir, "api", "openapi", "settings.json"),
      JSON.stringify({ spaces: 2 }),
    );

    const contracts = (await inspectProject(dir)).suggestions.filter(
      (s) => s.kind === "contract",
    );
    expect(contracts.map((s) => s.file)).toEqual([
      path.join("api", "openapi", "orders.yaml"),
    ]);
  });

  it("names one pack once, however many things point at it", async () => {
    writeManifest({
      dependencies: { "react-router": "^7.0.0", "react-router-dom": "^7.0.0" },
    });
    expect(await names(dir)).toEqual(["react-router"]);
  });

  it("ignores node_modules, which would otherwise match everything", async () => {
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "node_modules", "some-package");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "schema.prisma"), "");
    expect(await names(dir)).toEqual([]);
  });

  it("leaves a nested project's schemas to that project", async () => {
    // A directory with its own package.json is its own project, so claiming
    // its schema here would report a sibling service's contract as this one's.
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "services", "other");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "package.json"), "{}");
    fs.writeFileSync(path.join(nested, "template.yaml"), TEMPLATE);

    expect(await names(dir)).toEqual([]);
  });

  it("still reads a subdirectory that is part of this project", async () => {
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "infra");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "template.yaml"), TEMPLATE);

    expect(await names(dir)).toEqual(["cloudformation"]);
  });

  it("notices whether the project has a tsconfig", async () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    expect((await inspectProject(dir)).tsconfig).toBeNull();
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    expect((await inspectProject(dir)).tsconfig).not.toBeNull();
  });

  it("survives a package.json that will not parse", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    await expect(inspectProject(dir)).resolves.toBeDefined();
  });

  it("suggests the Python packs for the libraries a requirements file names", async () => {
    fs.writeFileSync(
      path.join(dir, "requirements.txt"),
      "fastapi>=0.110\nFlask-RESTX~=1.3\n",
    );
    expect(await names(dir)).toEqual(["fastapi", "flask-restx"]);
  });

  it("reads a Python project's libraries out of pyproject too", async () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
    );
    expect(await names(dir)).toEqual(["fastapi"]);
  });

  it("suggests the Ruby pack for the gem a lock file names", async () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  graphql (~> 2.0)\n",
    );
    expect(await names(dir)).toEqual(["graphql-ruby"]);
  });

  it("suggests the rails pack for a project depending on the rails gem", async () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  rails (~> 7.1)\n",
    );
    // ActiveRecord comes with Rails, so the same gem points at both.
    expect(await names(dir)).toEqual(["activerecord", "rails"]);
  });

  it("prints the config init --write would write, not the pack's example", async () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  rails (~> 7.1)\n",
    );
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(
      path.join(dir, "config", "database.yml"),
      "default:\n  adapter: postgresql\n",
    );
    const output = formatInitReport(await inspectProject(dir));

    expect(output).toContain(
      "activerecord reads suss.activerecord.json, and `suss init --write` writes this to it:",
    );
    expect(output).toContain('{"storageSystem":"postgresql"}');
    expect(output).toContain('{"root":"app","routesFile":"config/routes.rb"}');
    expect(output).not.toContain("reads nothing until you tell it");
    expect(output).not.toContain("engines/*");
  });

  it("says a pack's config file is already there instead of printing values", async () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  graphql (~> 2.0)\n",
    );
    fs.writeFileSync(
      path.join(dir, "suss.graphql-ruby.json"),
      '{ "root": "app/schema" }\n',
    );
    const output = formatInitReport(await inspectProject(dir));

    expect(output).toContain(
      "graphql-ruby reads suss.graphql-ruby.json, which is already here.",
    );
    expect(output).not.toContain('{"root":"app/graphql"}');
  });

  it("says which per-project config a suggested pack needs", async () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  graphql (~> 2.0)\n",
    );
    const suggestion = (await inspectProject(dir)).suggestions[0];
    expect(suggestion?.language).toBe("ruby");
    expect(suggestion?.configuration?.required).toBe(true);
    expect(suggestion?.configuration?.example).toEqual({ root: "app/graphql" });
  });

  it("says which framework it knows and cannot read, rather than a bare no-match", async () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "flask==3.0.0\n");
    const report = await inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(report.recognizedWithoutPack).toEqual(["flask"]);

    const output = formatInitReport(report);
    expect(output).toContain("depends on flask");
    expect(output).toContain("no pack for");
  });

  it("names a framework it cannot read even when another pack matched", async () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "GEM\n  specs:\n    grape (2.0.0)\n    faraday (2.9.0)\n\nDEPENDENCIES\n  grape\n  faraday\n",
    );
    const report = await inspectProject(dir);
    expect(declaredPacks(report).length).toBeGreaterThan(0);
    expect(report.recognizedWithoutPack).toEqual(["grape"]);
    expect(formatInitReport(report)).toContain(
      "This project depends on grape, which suss knows and has no pack for yet",
    );
  });

  it("reports a manifest it could not read rather than saying nothing", async () => {
    fs.writeFileSync(
      path.join(dir, "setup.py"),
      "setup(install_requires=read_requirements())\n",
    );
    const report = await inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(report.unread?.[0]?.where).toBe("setup.py");
  });

  it("reports a setup.cfg that points its dependency list somewhere else", async () => {
    fs.writeFileSync(
      path.join(dir, "setup.cfg"),
      "[options]\ninstall_requires = file: requirements.txt\n",
    );
    const report = await inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(report.unread?.[0]?.where).toBe("setup.cfg");
  });

  it("reports a submodule nobody checked out, whose code it cannot read", async () => {
    fs.writeFileSync(
      path.join(dir, ".gitmodules"),
      '[submodule "libs/framework"]\n\tpath = libs/framework\n',
    );
    fs.mkdirSync(path.join(dir, "libs", "framework"), { recursive: true });
    expect((await inspectProject(dir)).unread?.[0]?.reason).toContain(
      "not checked out",
    );
  });

  it("names the languages it found source for", async () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\n");
    expect((await inspectProject(dir)).languages).toEqual(["python"]);
  });
});

describe("formatInitReport", () => {
  it("prints one extract command covering every pack", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: "/project/tsconfig.json",
      suggestions: [
        {
          name: "hono",
          packageName: "@suss/framework-hono",
          because: "hono in dependencies",
          kind: "framework",
        },
        {
          name: "axios",
          packageName: "@suss/client-axios",
          because: "axios in dependencies",
          kind: "client",
        },
      ],
    });

    // One pass over the project reads every pack, so one command does.
    expect(output).toContain("suss extract -f hono -f axios");
    // The packs ship inside the CLI, so the install step names it alone.
    expect(output).toContain("npm install --save-dev @suss/cli");
    expect(output).not.toContain("@suss/framework-hono");
  });

  it("puts the file it found into the contract command", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: null,
      suggestions: [
        {
          name: "cloudformation",
          packageName: "@suss/contract-cloudformation",
          because: "a SAM template at template.yaml",
          kind: "contract",
          file: "template.yaml",
        },
      ],
    });

    expect(output).toContain(
      "suss contract --from cloudformation template.yaml",
    );
  });

  it("gives each language its own extract command, and names the config file", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: null,
      languages: ["typescript", "ruby"],
      suggestions: [
        {
          name: "hono",
          packageName: "@suss/framework-hono",
          because: "hono in dependencies",
          kind: "framework",
          language: "typescript",
        },
        {
          name: "graphql-ruby",
          packageName: "@suss/framework-graphql-ruby",
          because: "graphql in Gemfile.lock",
          kind: "framework",
          language: "ruby",
          configuration: {
            file: "suss.graphql-ruby.json",
            example: { root: "app/graphql" },
            required: true,
            why: "the directory your schema lives in.",
          },
        },
      ],
    });

    // With Ruby beside it, a bare extract would read the directory as
    // whichever language the manifest says, so the TypeScript one says so.
    expect(output).toContain(
      "suss extract --lang typescript -f hono -o summaries/typescript.json",
    );
    expect(output).toContain(
      "suss extract --lang ruby -f graphql-ruby=suss.graphql-ruby.json",
    );
    expect(output).toContain('{"root":"app/graphql"}');
  });

  it("writes a folder's commands to run from where init ran, into one summaries folder", () => {
    const commands = readCommands(
      {
        root: "/repo/services/api",
        tsconfig: null,
        languages: ["ruby"],
        suggestions: [
          {
            name: "graphql-ruby",
            packageName: "@suss/framework-graphql-ruby",
            because: "graphql in Gemfile.lock",
            kind: "framework",
            language: "ruby",
            configuration: {
              file: "suss.graphql-ruby.json",
              example: { root: "app/graphql" },
              required: true,
              why: "the directory your schema lives in.",
            },
          },
          {
            name: "openapi",
            packageName: "@suss/contract-openapi",
            because: "an OpenAPI document at openapi.yaml",
            kind: "contract",
            file: "openapi.yaml",
          },
        ],
      },
      "services/api",
    );

    expect(commands.map((command) => command.args.join(" "))).toEqual([
      "extract --dir services/api --lang ruby -f graphql-ruby=services/api/suss.graphql-ruby.json -o summaries/services-api-code.json",
      "contract --from openapi services/api/openapi.yaml -o summaries/services-api-openapi.json",
    ]);
    expect(commands[0]?.needsConfig).toEqual([
      "services/api/suss.graphql-ruby.json",
    ]);
  });

  it("lists a command's packs in the order the report groups them", () => {
    const pack = (name: string, kind: "framework" | "client" | "effects") => ({
      name,
      packageName: `@suss/${name}`,
      because: `${name} in dependencies`,
      kind,
      language: "typescript" as const,
    });
    const [extract] = readCommands({
      root: "/project",
      tsconfig: null,
      suggestions: [
        pack("prisma", "effects"),
        pack("fetch", "client"),
        pack("hono", "framework"),
      ],
    });

    expect(extract?.args.join(" ")).toBe(
      "extract -f hono -f fetch -f prisma -o summaries/code.json",
    );
  });

  it("keeps an effects pack's warning to its own language", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: "/project/tsconfig.json",
      languages: ["typescript", "python"],
      suggestions: [
        {
          name: "react",
          packageName: "@suss/framework-react",
          because: "react in dependencies",
          kind: "framework",
          language: "typescript",
        },
        {
          name: "sqlalchemy",
          packageName: "@suss/framework-sqlalchemy",
          because: "sqlalchemy in pyproject.toml",
          kind: "effects",
          language: "python",
        },
      ],
    });

    expect(output).toContain(
      "suss extract --lang typescript -f react -o summaries/typescript.json",
    );
    expect(output).toContain("suss extract --lang python -f sqlalchemy ...");
    expect(output).not.toContain("-f react -f sqlalchemy");
  });

  it("says what it could not read, so an empty answer is not mistaken for none", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: null,
      languages: ["python"],
      suggestions: [],
      unread: [
        {
          where: "setup.py",
          reason: "its install_requires is computed rather than written out.",
        },
      ],
    });

    expect(output).toContain("What suss could not read");
    expect(output).toContain("setup.py");
  });

  it("says so plainly when nothing matched", () => {
    const output = formatInitReport({
      root: "/project",
      tsconfig: null,
      suggestions: [],
    });

    expect(output).toContain("Nothing in /project matched a pack");
    expect(output).toContain("suss --help");
  });
});

describe("a project with more than one contract file", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-contracts-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names each SAM template, since two are two services", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "orders"));
    fs.mkdirSync(path.join(dir, "billing"));
    fs.writeFileSync(path.join(dir, "orders", "template.yaml"), TEMPLATE);
    fs.writeFileSync(path.join(dir, "billing", "template.yaml"), TEMPLATE);

    const report = await inspectProject(dir);
    const files = report.suggestions
      .filter((suggestion) => suggestion.name === "cloudformation")
      .map((suggestion) => suggestion.file)
      .sort();

    expect(files).toEqual(["billing/template.yaml", "orders/template.yaml"]);
  });

  it("tells a GraphQL schema apart from the operations beside it", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "schema.graphql"),
      "type Query { viewer: User }\ntype User { id: ID! }\n",
    );
    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(
      path.join(dir, "app", "viewer-fragment.graphql"),
      "fragment CachedViewer on User { id }\n",
    );

    const report = await inspectProject(dir);
    const read = Object.fromEntries(
      report.suggestions
        .filter((suggestion) => suggestion.kind === "contract")
        .map((suggestion) => [suggestion.name, suggestion.file]),
    );

    expect(read).toEqual({ graphql: "schema.graphql" });
  });

  it("reads a directory of operations, and leaves a fragment alone", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "operations"));
    fs.writeFileSync(
      path.join(dir, "operations", "viewer.graphql"),
      "query Viewer { viewer { id ...Cached } }\n",
    );
    fs.writeFileSync(
      path.join(dir, "operations", "cached.graphql"),
      "fragment Cached on User { id }\n",
    );

    const report = await inspectProject(dir);
    const read = report.suggestions
      .filter((suggestion) => suggestion.kind === "contract")
      .map((suggestion) => `${suggestion.name} ${suggestion.file}`);

    expect(read).toEqual(["graphql-documents operations"]);
  });
});

describe("a reader that walks a directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-walked-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is named once for everything under it", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    for (const component of ["Button", "Chip", "Table"]) {
      const under = path.join(dir, "src", "components", component);
      fs.mkdirSync(under, { recursive: true });
      fs.writeFileSync(path.join(under, `${component}.stories.tsx`), STORY);
    }

    const report = await inspectProject(dir);
    const stories = report.suggestions.filter((s) => s.name === "storybook");

    expect(stories.map((s) => s.file)).toEqual([
      path.join("src", "components"),
    ]);
  });

  it("prints no command for stories the reader finds nothing in, and says why", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "src", "__stories__"), { recursive: true });
    // A story that renders through a setup function has no component.
    fs.writeFileSync(
      path.join(dir, "src", "__stories__", "App.stories.ts"),
      "export default { title: 'Chat', render: () => ({}) };\nexport const Full = { args: {} };\n",
    );

    const report = await withReadableContracts(await inspectProject(dir));
    const printed = formatInitReport(report);

    expect(report.suggestions.filter((s) => s.kind === "contract")).toEqual([]);
    expect(report.emptyContracts).toEqual([
      {
        name: "storybook",
        because: `Storybook stories under ${path.join("src", "__stories__")}`,
        reason: "the storybook reader found nothing it reads there",
        warnings: [],
      },
    ]);
    expect(printed).not.toContain("suss contract");
    expect(printed).toContain("Contracts with nothing to read");
  });

  it("leaves the readers out of inspectProject, which check and --out-dir run on a time budget", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "openapi.json"), "{ not json");

    const report = await inspectProject(dir);

    const contracts = report.suggestions.filter((s) => s.kind === "contract");
    expect(contracts.map((s) => `${s.name} ${s.file}`)).toEqual([
      "openapi openapi.json",
    ]);
    expect(report.emptyContracts).toBeUndefined();
  });

  it("says why it prints no command for a contract its reader cannot parse", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "openapi.json"), "{ not json");

    const report = await withReadableContracts(await inspectProject(dir));

    expect(report.suggestions.filter((s) => s.kind === "contract")).toEqual([]);
    expect(report.emptyContracts?.[0]?.reason).toMatch(
      /^the openapi reader could not read it: /,
    );
  });

  it("keeps a reader quiet while init checks it, and shows what it said under the skipped contract", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "openapi.yaml"),
      "openapi: 3.0.3\npaths:\n  /orders:\n    $ref: ./paths/orders.yaml\n",
    );
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

    let report: InitReport;
    try {
      report = await withReadableContracts(await inspectProject(dir));
    } finally {
      spy.mockRestore();
    }

    expect(written).toEqual([]);
    expect(report.emptyContracts?.[0]?.warnings).toEqual([
      expect.stringContaining("could not read paths/orders.yaml"),
    ]);
    expect(formatInitReport(report)).toContain(
      "could not read paths/orders.yaml",
    );
  });

  it("gives two files read by one reader their own output", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    for (const name of ["schema-main", "schema-staging"]) {
      fs.writeFileSync(
        path.join(dir, `${name}.graphql`),
        "type Query { viewer: String }\n",
      );
    }

    const printed = formatInitReport(await inspectProject(dir));

    expect(printed).toContain("-o summaries/graphql-schema-main.json");
    expect(printed).toContain("-o summaries/graphql-schema-staging.json");
  });

  it("reads a query file as a document, whatever its fields are called", async () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "product.graphql"),
      "query Product($slug: String!) { product(slug: $slug) { id type } }\n",
    );

    const report = await inspectProject(dir);
    const read = report.suggestions
      .filter((s) => s.kind === "contract")
      .map((s) => s.name);

    expect(read).toEqual(["graphql-documents"]);
  });
});

/** An OpenAPI document with one GET per path. */
function openapiWith(paths: readonly string[]): string {
  return [
    "openapi: 3.0.3",
    "info: { title: orders, version: '1' }",
    "paths:",
    ...paths.flatMap((one) => [
      `  ${one}:`,
      "    get:",
      "      responses:",
      "        '200':",
      "          description: ok",
    ]),
  ].join("\n");
}

describe("contract files that declare the same boundaries", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-covered-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "spec", "groups"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function offered(): Promise<InitReport> {
    return await withReadableContracts(await inspectProject(dir));
  }

  const contractFiles = (report: InitReport): Array<string | undefined> =>
    report.suggestions
      .filter((suggestion) => suggestion.kind === "contract")
      .map((suggestion) => suggestion.file);

  it("offers a spec once when a bundle and a tag group repeat its operations", async () => {
    const all = ["/orders", "/orders/{id}", "/invoices"];
    fs.writeFileSync(path.join(dir, "spec", "index.yaml"), openapiWith(all));
    // The bundle spells the same operations at more length.
    fs.writeFileSync(
      path.join(dir, "spec", "bundle.yaml"),
      `${openapiWith(all)}\n# built from index.yaml\n`,
    );
    fs.writeFileSync(
      path.join(dir, "spec", "groups", "orders.yaml"),
      openapiWith(["/orders", "/orders/{id}"]),
    );

    const report = await offered();

    expect(contractFiles(report)).toEqual([path.join("spec", "index.yaml")]);
    expect(
      report.coveredContracts?.map((entry) => [entry.because, entry.coveredBy]),
    ).toEqual([
      [
        `an OpenAPI document at ${path.join("spec", "bundle.yaml")}`,
        path.join("spec", "index.yaml"),
      ],
      [
        `an OpenAPI document at ${path.join("spec", "groups", "orders.yaml")}`,
        path.join("spec", "index.yaml"),
      ],
    ]);
    const printed = formatInitReport(report);
    expect(printed).toContain("Contracts another file already declares");
    expect(printed).not.toContain("spec/bundle.yaml -o");
  });

  it("offers one of two identical copies", async () => {
    const same = openapiWith(["/orders"]);
    fs.writeFileSync(path.join(dir, "spec", "openapi.yaml"), same);
    fs.writeFileSync(path.join(dir, "spec", "groups", "openapi.yaml"), same);

    expect(contractFiles(await offered())).toHaveLength(1);
  });

  it("offers both specs when one describes a shared operation differently", async () => {
    fs.writeFileSync(
      path.join(dir, "spec", "openapi.yaml"),
      openapiWith(["/orders", "/invoices"]),
    );
    fs.writeFileSync(
      path.join(dir, "spec", "groups", "served.yaml"),
      openapiWith(["/orders"]).replace("'200'", "'201'"),
    );

    expect(contractFiles(await offered())).toHaveLength(2);
  });

  it("offers both specs when each declares an operation the other lacks", async () => {
    fs.writeFileSync(
      path.join(dir, "spec", "orders.yaml"),
      openapiWith(["/health", "/orders"]),
    );
    fs.writeFileSync(
      path.join(dir, "spec", "groups", "invoices.yaml"),
      openapiWith(["/health", "/invoices"]),
    );

    expect(contractFiles(await offered())).toHaveLength(2);
  });
});

describe("a folder an extract would read nothing in", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-unread-folder-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints no extract when the tsconfig above leaves the folder out, and says why", () => {
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ include: ["shared/**/*.ts"] }),
    );
    fs.mkdirSync(path.join(dir, "shared"));
    fs.writeFileSync(
      path.join(dir, "shared", "money.ts"),
      "export const x = 1;",
    );
    const folder = path.join(dir, "plugins", "ledger");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "package.json"),
      JSON.stringify({ peerDependencies: { react: "^19.0.0" } }),
    );
    fs.writeFileSync(
      path.join(folder, "index.tsx"),
      "export const Ledger = () => <div />;",
    );
    const report: InitReport = {
      root: folder,
      tsconfig: null,
      suggestions: [
        {
          name: "react",
          packageName: "@suss/framework-react",
          because: "react in peerDependencies",
          kind: "framework",
          language: "typescript",
        },
      ],
      languages: ["typescript"],
    };

    const checked = withReadableCode(report);
    const printed = formatInitReport(checked, "plugins/ledger");

    expect(declaredPacks(checked)).toEqual([]);
    expect(checked.emptyExtracts).toEqual([
      {
        language: "typescript",
        packs: ["react"],
        reason: `an extract here reads through ${path.join("..", "..", "tsconfig.json")}, which doesn't include any file in this folder`,
      },
    ]);
    expect(printed).not.toContain("suss extract");
    expect(printed).toContain("Code with nothing to read");
    expect(printed).not.toContain("could not tell which packs");
  });

  it("keeps the extract when the tsconfig above includes the folder", () => {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({}));
    const folder = path.join(dir, "plugins", "ledger");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "index.ts"), "export const x = 1;");
    const report: InitReport = {
      root: folder,
      tsconfig: null,
      suggestions: [
        {
          name: "express",
          packageName: "@suss/framework-express",
          because: "express in dependencies",
          kind: "framework",
          language: "typescript",
        },
      ],
    };

    expect(withReadableCode(report)).toBe(report);
  });

  it("says so when the folder's own tsconfig lists no source", () => {
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ files: ["package.json"] }),
    );
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};");
    const report: InitReport = {
      root: dir,
      tsconfig: path.join(dir, "tsconfig.json"),
      suggestions: [
        {
          name: "axios",
          packageName: "@suss/client-axios",
          because: "axios in dependencies",
          kind: "client",
          language: "typescript",
        },
      ],
    };

    expect(withReadableCode(report).emptyExtracts?.[0]?.reason).toBe(
      "tsconfig.json here doesn't include any source file",
    );
  });
});
