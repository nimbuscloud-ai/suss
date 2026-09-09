import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatInitReport, inspectProject } from "./init.js";

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
      JSON.stringify({ swagger: "2.0", paths: {} }),
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
    fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}\n");
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
    fs.writeFileSync(path.join(nested, "template.yaml"), "Resources: {}\n");

    expect(await names(dir)).toEqual([]);
  });

  it("still reads a subdirectory that is part of this project", async () => {
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "infra");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "template.yaml"), "Resources: {}\n");

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

    expect(output).toContain(
      "suss extract -f hono -o summaries/typescript.json",
    );
    expect(output).toContain(
      "suss extract --lang ruby -f graphql-ruby=suss.graphql-ruby.json",
    );
    expect(output).toContain('{"root":"app/graphql"}');
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
    fs.writeFileSync(
      path.join(dir, "orders", "template.yaml"),
      "Resources: {}\n",
    );
    fs.writeFileSync(
      path.join(dir, "billing", "template.yaml"),
      "Resources: {}\n",
    );

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
