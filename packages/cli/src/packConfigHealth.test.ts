// A pack that cannot read anything without an option says so in the pack
// health block, in the incompleteness note, and in `check --json`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDir } from "./check.js";
import {
  builtinDeclarations,
  extract,
  incompletenessPathFor,
  languageOfPack,
} from "./extract.js";

import type { Language } from "./language.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const railsApp = path.join(repoRoot, "fixtures", "ruby-rails");

/** A project of each language that has code for a pack's library to read. */
const PROJECT_OF: Record<Language, string> = {
  typescript: path.join(repoRoot, "fixtures", "express-helpers"),
  python: path.join(repoRoot, "fixtures", "python-webapp"),
  ruby: path.join(repoRoot, "fixtures", "ruby-graphql"),
};

let scratch: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-pack-config-"));
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  fs.rmSync(scratch, { recursive: true, force: true });
});

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

async function packsThatNeedConfig(): Promise<
  Array<{ name: string; option: string }>
> {
  const found = [];
  for (const { name, declares } of await builtinDeclarations()) {
    const configuration = declares.configuration;
    if (configuration?.required === true) {
      found.push({
        name,
        option: Object.keys(configuration.example)[0] as string,
      });
    }
  }
  return found;
}

describe("a pack that needs an option the run did not give", () => {
  it("is one of graphql-ruby, activerecord, sqlalchemy and sqlmodel", async () => {
    const names = (await packsThatNeedConfig()).map((pack) => pack.name);
    expect(names.sort()).toEqual([
      "activerecord",
      "graphql-ruby",
      "sqlalchemy",
      "sqlmodel",
    ]);
  });

  it("is reported by every pack that declares its config required", async () => {
    for (const pack of await packsThatNeedConfig()) {
      const language = languageOfPack(pack.name);
      process.exitCode = undefined;

      const stderr = await stderrOf(() =>
        extract({
          dir: PROJECT_OF[language],
          lang: language,
          frameworks: [pack.name],
          noCache: true,
          output: path.join(scratch, `${pack.name}.json`),
        }),
      );

      const line = stderr
        .split("\n")
        .find((one) => /^\s+no-config\s/.test(one));
      expect(line, pack.name).toContain(pack.name);
      expect(line, pack.name).toContain(
        `reads nothing until ${pack.option} is set, for example {"${pack.option}":`,
      );
      expect(process.exitCode, pack.name).toBe(1);
    }
  });

  it("leaves the run to the other packs, and still prints the line", async () => {
    const output = path.join(scratch, "rails.json");

    const stderr = await stderrOf(() =>
      extract({
        dir: railsApp,
        lang: "ruby",
        frameworks: ["rails", "graphql-ruby"],
        noCache: true,
        output,
      }),
    );

    expect(stderr).toMatch(
      /no-config\s+graphql-ruby\s+reads nothing until root/,
    );
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(output, "utf8")).length).toBeGreaterThan(
      0,
    );
  });

  it("goes into the note beside the summaries, and out of it once fixed", async () => {
    const output = path.join(scratch, "ruby.json");
    const options = {
      dir: railsApp,
      lang: "ruby" as const,
      noCache: true,
      output,
    };

    await stderrOf(() =>
      extract({ ...options, frameworks: ["rails", "graphql-ruby"] }),
    );
    const note = JSON.parse(
      fs.readFileSync(incompletenessPathFor(output), "utf8"),
    );
    expect(note.packsNeedingConfig).toEqual([
      {
        pack: "graphql-ruby",
        option: "root",
        example: '{"root":"app/graphql"}',
      },
    ]);

    await stderrOf(() => extract({ ...options, frameworks: ["rails"] }));
    expect(fs.existsSync(incompletenessPathFor(output))).toBe(false);
  });

  it("appears in check --json as a warning that does not fail a run that paired", async () => {
    const dir = path.join(scratch, "summaries");
    const report = path.join(scratch, "report.json");
    fs.mkdirSync(dir);
    await stderrOf(() =>
      extract({
        dir: railsApp,
        lang: "ruby",
        frameworks: ["rails", "graphql-ruby"],
        noCache: true,
        output: path.join(dir, "code.json"),
      }),
    );

    const result = await (async () => {
      let checked: ReturnType<typeof checkDir> | undefined;
      await stderrOf(async () => {
        checked = checkDir({
          dir,
          json: true,
          allowEmpty: true,
          output: report,
        });
      });
      return checked as ReturnType<typeof checkDir>;
    })();

    const { run } = JSON.parse(fs.readFileSync(report, "utf8")) as {
      run: Array<{ kind: string; severity: string; description: string }>;
    };
    const finding = run.find((one) => one.kind === "packNeedsConfig");
    expect(finding?.severity).toBe("warning");
    expect(finding?.description).toContain("graphql-ruby");
    expect(finding?.description).toContain('{"root":"app/graphql"}');
    expect(result.hasErrors).toBe(false);
  });

  it("still refuses a pack written for another language", async () => {
    await expect(
      extract({
        dir: PROJECT_OF.python,
        lang: "python",
        frameworks: ["graphql-ruby"],
        noCache: true,
      }),
    ).rejects.toThrow(/reads Ruby/);
  });
});
