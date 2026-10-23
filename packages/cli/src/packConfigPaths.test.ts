// A relative path in a pack config kept outside the project points at
// nothing. The health block, the note beside the summaries and
// `check --json` each say so.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDir } from "./check.js";
import {
  BUILTIN_FRAMEWORKS,
  extract,
  incompletenessPathFor,
} from "./extract.js";

import type { ExtractOptions } from "./extract.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const fixture = (name: string) => path.join(repoRoot, "fixtures", name);
const graphqlApp = fixture("ruby-graphql-resolvers");
const railsApp = fixture("ruby-rails");

let scratch: string;
let elsewhere: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pack-paths-"));
  elsewhere = path.join(scratch, "configs");
  fs.mkdirSync(elsewhere);
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  fs.rmSync(scratch, { recursive: true, force: true });
});

function configFile(name: string, options: Record<string, unknown>): string {
  const file = path.join(elsewhere, name);
  fs.writeFileSync(file, JSON.stringify(options));
  return file;
}

async function stderrOf(run: () => Promise<unknown>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let written = "";
  process.stderr.write = ((chunk: string) => {
    written += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

async function extractInto(
  options: Omit<ExtractOptions, "output" | "noCache">,
): Promise<{ stderr: string; output: string }> {
  const dir = path.join(scratch, "summaries");
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, "code.json");
  const stderr = await stderrOf(() =>
    extract({ ...options, noCache: true, output }),
  );
  return { stderr, output };
}

function noteOf(output: string): Record<string, unknown> | null {
  const note = incompletenessPathFor(output);
  return fs.existsSync(note) ? JSON.parse(fs.readFileSync(note, "utf8")) : null;
}

interface RunFindingJson {
  kind: string;
  severity: string;
  description: string;
  remedy: string;
}

async function runFindingsOver(
  dir: string,
): Promise<{ run: RunFindingJson[]; hasErrors: boolean }> {
  const report = path.join(scratch, "report.json");
  let checked: ReturnType<typeof checkDir> | undefined;
  await stderrOf(async () => {
    checked = checkDir({ dir, json: true, allowEmpty: true, output: report });
  });
  const { run } = JSON.parse(fs.readFileSync(report, "utf8"));
  return { run, hasErrors: (checked as ReturnType<typeof checkDir>).hasErrors };
}

describe("a Ruby pack config kept outside the project", () => {
  it("reports a relative graphql-ruby root that points at nothing, and where it should point", async () => {
    const config = configFile("suss.graphql-ruby.json", {
      root: "app/graphql",
    });

    const { stderr, output } = await extractInto({
      dir: graphqlApp,
      lang: "ruby",
      frameworks: [`graphql-ruby=${config}`],
    });

    const lines = stderr.split("\n").filter((one) => /^\s+no-path\s/.test(one));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `graphql-ruby  root is app/graphql in ${config}, and nothing exists at ${path.join(elsewhere, "app", "graphql")}.`,
    );
    expect(lines[0]).toContain(
      `Set root to ${path.join(graphqlApp, "app", "graphql")} in the config file`,
    );
    expect(process.exitCode).toBeUndefined();

    expect(noteOf(output)?.packPathsMissing).toEqual([
      {
        pack: "graphql-ruby",
        option: "root",
        value: "app/graphql",
        configFile: config,
        resolved: path.join(elsewhere, "app", "graphql"),
        inProject: path.join(graphqlApp, "app", "graphql"),
      },
    ]);
  });

  it("carries it into check --json as a warning that leaves the run passing", async () => {
    const config = configFile("suss.graphql-ruby.json", {
      root: "app/graphql",
    });
    const { output } = await extractInto({
      dir: graphqlApp,
      lang: "ruby",
      frameworks: [`graphql-ruby=${config}`],
    });

    const { run, hasErrors } = await runFindingsOver(path.dirname(output));

    const finding = run.find((one) => one.kind === "packPathMissing");
    expect(finding?.severity).toBe("warning");
    expect(finding?.description).toContain(
      `The graphql-ruby pack's root is app/graphql in ${config}`,
    );
    expect(finding?.remedy).toContain(
      `Set root to ${path.join(graphqlApp, "app", "graphql")}`,
    );
    expect(hasErrors).toBe(false);
  });

  it("reports nothing once the root is absolute, and drops the note", async () => {
    const relative = configFile("relative.json", { root: "app/graphql" });
    const { output } = await extractInto({
      dir: graphqlApp,
      lang: "ruby",
      frameworks: [`graphql-ruby=${relative}`],
    });
    expect(noteOf(output)).not.toBeNull();

    const absolute = configFile("absolute.json", {
      root: path.join(graphqlApp, "app", "graphql"),
    });
    const { stderr } = await extractInto({
      dir: graphqlApp,
      lang: "ruby",
      frameworks: [`graphql-ruby=${absolute}`],
    });

    expect(stderr).not.toMatch(/no-path/);
    expect(noteOf(output)).toBeNull();
  });

  it("reports each rails path option, including a pattern whose directory is missing", async () => {
    const config = configFile("suss.rails.json", {
      root: "app",
      routesFile: "config/routes.rb",
      engineRoots: ["engines/*"],
    });

    const { output } = await extractInto({
      dir: railsApp,
      lang: "ruby",
      frameworks: [`rails=${config}`],
    });

    const missing = noteOf(output)?.packPathsMissing as Array<{
      option: string;
      inProject?: string;
    }>;
    expect(missing.map((one) => one.option)).toEqual([
      "root",
      "routesFile",
      "engineRoots",
    ]);
    expect(missing[0]?.inProject).toBe(path.join(railsApp, "app"));
    expect(missing[1]?.inProject).toBe(
      path.join(railsApp, "config", "routes.rb"),
    );
    expect(missing[2]?.inProject).toBeUndefined();
  });

  it("fails the extract with --fail-on-pack-error", async () => {
    const config = configFile("suss.graphql-ruby.json", {
      root: "app/graphql",
    });

    const { stderr } = await extractInto({
      dir: graphqlApp,
      lang: "ruby",
      frameworks: [`graphql-ruby=${config}`],
      failOnPackError: true,
    });

    expect(stderr).toContain(
      "Failing because a path in the config for graphql-ruby points at nothing (--fail-on-pack-error).",
    );
    expect(process.exitCode).toBe(1);
  });
});

/** The express pack, wrapped so that it declares a path option. No built-in TypeScript pack takes one. */
function typescriptPackWithAPathOption(): string {
  const express = path.join(
    repoRoot,
    "packages",
    "framework",
    "express",
    "dist",
    "index.js",
  );
  const file = path.join(scratch, "pathPack.mjs");
  fs.writeFileSync(
    file,
    [
      `import express, { declares as base } from ${JSON.stringify(express)};`,
      "export default () => express({});",
      "export const declares = {",
      "  ...base,",
      '  configuration: { file: "suss.probe.json", example: { schemaDir: "src" }, required: false, why: "a probe", paths: ["schemaDir"] },',
      "};",
    ].join("\n"),
  );
  return file;
}

describe("a TypeScript pack config kept outside the project", () => {
  it("reports a relative path that points at nothing", async () => {
    const pack = typescriptPackWithAPathOption();
    const config = configFile("suss.probe.json", { schemaDir: "src" });

    const { stderr, output } = await extractInto({
      dir: fixture("express-helpers"),
      lang: "typescript",
      frameworks: [`${pack}=${config}`],
    });

    expect(stderr).toContain(
      `schemaDir is src in ${config}, and nothing exists at ${path.join(elsewhere, "src")}.`,
    );
    expect(noteOf(output)?.packPathsMissing).toEqual([
      expect.objectContaining({ pack, option: "schemaDir", value: "src" }),
    ]);
  });
});

describe("a Python pack config kept outside the project", () => {
  it("reports nothing for an option that is not a path", async () => {
    const config = configFile("suss.sqlalchemy.json", {
      storageSystem: "postgresql",
    });

    const { stderr, output } = await extractInto({
      dir: fixture("python-webapp"),
      lang: "python",
      frameworks: ["flask-restx", `sqlalchemy=${config}`],
    });

    expect(stderr).not.toMatch(/no-path/);
    expect(noteOf(output)?.packPathsMissing).toBeUndefined();
  });
});

describe("the options a built-in pack resolves as paths", () => {
  it("are declared by every pack that takes the config file's directory", async () => {
    const undeclared: string[] = [];
    for (const [name, specifier] of Object.entries(BUILTIN_FRAMEWORKS)) {
      const mod = (await import(specifier)) as {
        optionsSchema?: { shape: Record<string, unknown> };
        declares?: { configuration?: { paths?: readonly string[] } };
      };
      const takesDirectory =
        mod.optionsSchema?.shape.configDirectory !== undefined;
      const paths = mod.declares?.configuration?.paths ?? [];
      if (takesDirectory && paths.length === 0) {
        undeclared.push(name);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
