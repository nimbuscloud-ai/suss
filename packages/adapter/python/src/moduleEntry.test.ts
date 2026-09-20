/**
 * A job with no handler, read end to end from the checked-in fixture.
 * Its entry file does the work while the module loads, so every SQL
 * statement it sends is behind a call written at module scope.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/python-job",
);

/** Inline rather than the shipped `@suss/framework-sqlalchemy`, which depends on this package. */
const sqlalchemyLike: PythonPack = {
  name: "sqlalchemy-inline-test-pack",
  protocol: "postgresql",
  discovery: [],
  rawSql: [
    { module: "sqlalchemy", functions: ["text"], storageSystem: "postgresql" },
  ],
};

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(fixtureRoot),
    packs: [sqlalchemyLike],
    roots: [fixtureRoot],
    workspaceRoot: fixtureRoot,
    cacheDir: null,
  });
  return summaries;
}

function unitNamed(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.filter((summary) => summary.identity.name === name);
  if (found.length !== 1) {
    throw new Error(`${found.length} summaries are named ${name}, wanted one`);
  }
  return found[0];
}

/** Each table this body touches and how, as "read dim_account". */
function storageIn(summary: BehavioralSummary): string[] {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) => {
      if (
        effect.type !== "interaction" ||
        effect.interaction.class !== "storage-access" ||
        effect.binding.semantics.name !== "storage"
      ) {
        return [];
      }
      return [
        `${effect.interaction.kind} ${effect.binding.semantics.container}`,
      ];
    }),
  );
}

function callTo(
  summary: BehavioralSummary,
  callee: string,
): string | undefined {
  return summary.transitions
    .flatMap((transition) =>
      transition.effects.flatMap((effect) =>
        effect.type === "invocation" ? [effect] : [],
      ),
    )
    .find((effect) => effect.callee === callee)?.summary;
}

describe("a job whose entry file works while the module loads", () => {
  it("reads the SQL behind every call the entry makes at module scope", async () => {
    const summaries = await extract();
    expect(storageIn(unitNamed(summaries, "sync_accounts"))).toEqual([
      "read dim_account",
    ]);
    expect(storageIn(unitNamed(summaries, "archive_accounts"))).toEqual([
      "write dim_account",
    ]);
  });

  it("reaches a function the entry only calls through the coroutine it runs", async () => {
    const summaries = await extract();
    expect(storageIn(unitNamed(summaries, "count_orders"))).toEqual([
      "read orders",
    ]);
    expect(callTo(unitNamed(summaries, "main"), "count_orders")).toBe(
      summaryIdentifier(unitNamed(summaries, "count_orders")),
    );
  });

  it("links the entry's module-init summary to what it called", async () => {
    const summaries = await extract();
    const entry = unitNamed(summaries, "sync.py");
    expect(entry.kind).toBe("module-init");
    expect(entry.identity.boundaryBinding).toBeNull();
    for (const callee of [
      "read_settings",
      "make_pool",
      "sync_accounts",
      "archive_accounts",
      "main",
    ]) {
      expect(callTo(entry, callee)).toBe(
        summaryIdentifier(unitNamed(summaries, callee)),
      );
    }
  });

  it("keeps the settings module's own load-time reads off the entry", async () => {
    const summaries = await extract();
    const names = unitNamed(summaries, "read_settings").transitions.flatMap(
      (transition) =>
        transition.effects.flatMap((effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "config-read"
            ? [effect.interaction.name]
            : [],
        ),
    );
    expect(names).toEqual(["ACCOUNTS_DSN", "BATCH_SIZE"]);
  });
});
