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

/** The summary each call the entry script makes was linked to, by callee. */
function callsFromEntry(): Map<string, string | undefined> {
  const entry = summaries.find(
    (s) => s.kind === "module-init" && s.location.file === "bin/run_sync.rb",
  );
  if (entry === undefined) {
    throw new Error("no module-init unit for bin/run_sync.rb");
  }
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

  it("leaves out a call written in a block the library decides to run", () => {
    expect(
      summaries.some((s) => s.location.file === "lib/tasks/nightly.rb"),
    ).toBe(false);
  });

  it("gives each reached method one summary", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "build_pool",
      "close_pool",
      "initialize",
      "run",
      "run_nightly",
      "run_report",
      "run_sync.rb",
      "sync_accounts",
    ]);
  });
});
