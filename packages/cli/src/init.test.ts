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

  function names(root: string): string[] {
    return inspectProject(root)
      .suggestions.map((s) => s.name)
      .sort();
  }

  it("picks a framework pack out of dependencies", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    expect(names(dir)).toEqual(["hono"]);
  });

  it("suggests the Next.js pack for a Next.js project", () => {
    writeManifest({ dependencies: { next: "^15.0.0" } });
    expect(names(dir)).toEqual(["nextjs"]);
  });

  it("reads devDependencies too, which is where the Lambda types live", () => {
    writeManifest({ devDependencies: { "@types/aws-lambda": "^8.10.0" } });
    expect(names(dir)).toEqual(["aws-lambda"]);
  });

  it("picks a client pack as well as a framework", () => {
    writeManifest({
      dependencies: { express: "^4.0.0", axios: "^1.0.0" },
    });
    expect(names(dir)).toEqual(["axios", "express"]);
  });

  it("finds a contract source on disk", () => {
    writeManifest({ dependencies: {} });
    fs.writeFileSync(path.join(dir, "template.yaml"), "Resources: {}\n");
    const report = inspectProject(dir);
    expect(report.suggestions.map((s) => s.name)).toEqual(["cloudformation"]);
    expect(report.suggestions[0]?.file).toBe("template.yaml");
  });

  it("names one pack once, however many things point at it", () => {
    writeManifest({
      dependencies: { "react-router": "^7.0.0", "react-router-dom": "^7.0.0" },
    });
    expect(names(dir)).toEqual(["react-router"]);
  });

  it("ignores node_modules, which would otherwise match everything", () => {
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "node_modules", "some-package");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "schema.prisma"), "");
    expect(names(dir)).toEqual([]);
  });

  it("leaves a nested project's schemas to that project", () => {
    // A directory with its own package.json is its own project, so claiming
    // its schema here would report a sibling service's contract as this one's.
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "services", "other");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "package.json"), "{}");
    fs.writeFileSync(path.join(nested, "template.yaml"), "Resources: {}\n");

    expect(names(dir)).toEqual([]);
  });

  it("still reads a subdirectory that is part of this project", () => {
    writeManifest({ dependencies: {} });
    const nested = path.join(dir, "infra");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "template.yaml"), "Resources: {}\n");

    expect(names(dir)).toEqual(["cloudformation"]);
  });

  it("notices whether the project has a tsconfig", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    expect(inspectProject(dir).tsconfig).toBeNull();
    fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    expect(inspectProject(dir).tsconfig).not.toBeNull();
  });

  it("survives a package.json that will not parse", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(() => inspectProject(dir)).not.toThrow();
  });

  it("suggests the Python packs for the libraries a requirements file names", () => {
    fs.writeFileSync(
      path.join(dir, "requirements.txt"),
      "fastapi>=0.110\nFlask-RESTX~=1.3\n",
    );
    expect(names(dir)).toEqual(["fastapi", "flask-restx"]);
  });

  it("reads a Python project's libraries out of pyproject too", () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
    );
    expect(names(dir)).toEqual(["fastapi"]);
  });

  it("suggests the Ruby pack for the gem a lock file names", () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  graphql (~> 2.0)\n",
    );
    expect(names(dir)).toEqual(["graphql-ruby"]);
  });

  it("says which per-project config a suggested pack needs", () => {
    fs.writeFileSync(
      path.join(dir, "Gemfile.lock"),
      "DEPENDENCIES\n  graphql (~> 2.0)\n",
    );
    const suggestion = inspectProject(dir).suggestions[0];
    expect(suggestion?.language).toBe("ruby");
    expect(suggestion?.configuration?.required).toBe(true);
    expect(suggestion?.configuration?.example).toEqual({ root: "app/graphql" });
  });

  it("says which framework it knows and cannot read, rather than a bare no-match", () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "flask==3.0.0\n");
    const report = inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(report.recognizedWithoutPack).toEqual(["flask"]);

    const output = formatInitReport(report);
    expect(output).toContain("depends on flask");
    expect(output).toContain("no pack for");
  });

  it("reports a manifest it could not read rather than saying nothing", () => {
    fs.writeFileSync(
      path.join(dir, "setup.py"),
      "setup(install_requires=read_requirements())\n",
    );
    const report = inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(report.unread?.[0]?.where).toBe("setup.py");
  });

  it("reports a setup.cfg that points its dependency list somewhere else", () => {
    fs.writeFileSync(
      path.join(dir, "setup.cfg"),
      "[options]\ninstall_requires = file: requirements.txt\n",
    );
    const report = inspectProject(dir);
    expect(report.suggestions).toEqual([]);
    expect(report.unread?.[0]?.where).toBe("setup.cfg");
  });

  it("reports a submodule nobody checked out, whose code it cannot read", () => {
    fs.writeFileSync(
      path.join(dir, ".gitmodules"),
      '[submodule "libs/framework"]\n\tpath = libs/framework\n',
    );
    fs.mkdirSync(path.join(dir, "libs", "framework"), { recursive: true });
    expect(inspectProject(dir).unread?.[0]?.reason).toContain(
      "not checked out",
    );
  });

  it("names the languages it found source for", () => {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\n");
    expect(inspectProject(dir).languages).toEqual(["python"]);
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
      languages: ["typescript", "python"],
      suggestions: [
        {
          name: "hono",
          packageName: "@suss/framework-hono",
          because: "hono in dependencies",
          kind: "framework",
          language: "typescript",
        },
        {
          name: "flask-restx",
          packageName: "@suss/framework-flask-restx",
          because: "flask-restx in requirements.txt",
          kind: "framework",
          language: "python",
          configuration: {
            file: "suss.flask-restx.json",
            example: { wrapperModules: ["myapp.wrappers.restx"] },
            required: false,
            why: "the modules your own code re-exports the route decorator from.",
          },
        },
      ],
    });

    expect(output).toContain(
      "suss extract -f hono -o summaries/typescript.json",
    );
    expect(output).toContain(
      "suss extract --lang python -f flask-restx=suss.flask-restx.json",
    );
    expect(output).toContain('{"wrapperModules":["myapp.wrappers.restx"]}');
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
