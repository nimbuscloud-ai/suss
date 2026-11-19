import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { summaryIdentifier } from "@suss/behavioral-ir";

import { activeRecordFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-job");

let summaries: BehavioralSummary[];

beforeAll(async () => {
  const extracted = await extractRubyProject({
    files: findRubyFiles(fixtureRoot),
    packs: [activeRecordFramework({ storageSystem: "postgresql" })],
    workspaceRoot: fixtureRoot,
    cacheDir: null,
  });
  summaries = extracted.summaries;
});

function unitNamed(name: string): BehavioralSummary {
  const found = summaries.find((s) => s.identity.name === name);
  if (found === undefined) {
    throw new Error(`no summary is named ${name}`);
  }
  return found;
}

/** The statement each call in a summary ran, as the kind of access and the method that ran it. */
function accesses(summary: BehavioralSummary) {
  return summary.transitions
    .flatMap((transition) => transition.effects)
    .flatMap((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access"
        ? [
            {
              kind: effect.interaction.kind,
              operation: effect.interaction.operation,
            },
          ]
        : [],
    );
}

function moduleInitOf(file: string): BehavioralSummary {
  const entry = summaries.find(
    (s) => s.kind === "module-init" && s.location.file === file,
  );
  if (entry === undefined) {
    throw new Error(`no module-init unit for ${file}`);
  }
  return entry;
}

function unfollowedIn(summary: BehavioralSummary): (string | undefined)[] {
  return summary.gaps
    .filter((gap) => gap.type === "unfollowedCall")
    .map((gap) => gap.callee);
}

/** The summary each call a script makes was linked to, by callee. */
function callsFromEntry(
  file = "bin/run_sync.rb",
): Map<string, string | undefined> {
  const entry = moduleInitOf(file);
  return new Map(
    entry.transitions
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "invocation" ? [[effect.callee, effect.summary]] : [],
      ) as [string, string | undefined][],
  );
}

describe("a job whose entry script does its work at module scope", () => {
  it("links every call the script makes to the method it runs", () => {
    const linked = callsFromEntry();
    expect(linked.get("build_pool")).toBe(
      summaryIdentifier(unitNamed("build_pool")),
    );
    expect(linked.get("run_report")).toBe(
      summaryIdentifier(unitNamed("run_report")),
    );
    expect(linked.get("ReportJob.new(SETTINGS).run")).toBe(
      summaryIdentifier(unitNamed("run")),
    );
    expect(linked.get("ReportJob.run_nightly")).toBe(
      summaryIdentifier(unitNamed("run_nightly")),
    );
    expect(linked.get("sync_accounts")).toBe(
      summaryIdentifier(unitNamed("sync_accounts")),
    );
    expect(linked.get("close_pool")).toBe(
      summaryIdentifier(unitNamed("close_pool")),
    );
  });

  it("puts the statement each reached method runs on that method's summary", () => {
    expect(accesses(unitNamed("run_report"))).toEqual([
      { kind: "read", operation: "execute" },
    ]);
    expect(accesses(unitNamed("sync_accounts"))).toEqual([
      { kind: "write", operation: "exec_query" },
    ]);
    expect(accesses(unitNamed("run"))).toEqual([
      { kind: "write", operation: "execute" },
    ]);
    expect(accesses(unitNamed("run_nightly"))).toEqual([
      { kind: "read", operation: "exec_query" },
    ]);
  });

  it("reads the environment the script reads as it loads", () => {
    const entry = summaries.find(
      (s) => s.kind === "module-init" && s.location.file === "bin/run_sync.rb",
    );
    const names = entry?.transitions
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "config-read"
          ? [effect.interaction.name]
          : [],
      );
    expect(names).toEqual(["STATEMENT_TIMEOUT"]);
  });

  it("leaves out a method the script declares and never calls", () => {
    expect(summaries.some((s) => s.identity.name === "drop_everything")).toBe(
      false,
    );
  });

  it("lists a call written in a block the library decides to run as one it did not follow", () => {
    const tasks = moduleInitOf("lib/tasks/nightly.rb");

    expect(callsFromEntry("lib/tasks/nightly.rb").has("run_report")).toBe(
      false,
    );
    expect(unfollowedIn(tasks)).toEqual(["run_report"]);
  });

  it("follows a call in a block Ruby runs in place, and lists one in a transaction block", () => {
    const backfill = moduleInitOf("bin/backfill.rb");

    expect(callsFromEntry("bin/backfill.rb").get("sync_accounts")).toBe(
      summaryIdentifier(unitNamed("sync_accounts")),
    );
    expect(callsFromEntry("bin/backfill.rb").has("close_pool")).toBe(false);
    expect(unfollowedIn(backfill)).toEqual(["close_pool"]);
  });

  it("gives each reached method one summary", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "backfill.rb",
      "build_pool",
      "close_pool",
      "initialize",
      "nightly.rb",
      "run",
      "run_nightly",
      "run_report",
      "run_sync.rb",
      "sync_accounts",
    ]);
  });
});
