import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rubyPackUnderTest, storageOf } from "@suss/pack-harness";

import {
  bigqueryRawSql,
  bigqueryRubyFramework,
  withBigquery,
} from "./index.js";

import type { RubyPack } from "@suss/adapter-ruby";
import type { Effect } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-bigquery");

const harness = rubyPackUnderTest(bigqueryRubyFramework());

/** The report the fixture reads BigQuery from, with the rest of the project around it. */
async function reportEffects(): Promise<Effect[]> {
  return harness.effectsUnder(fixtureRoot, "app/reports/account_report.rb");
}

/** The store, namespace, table and access kind of the effect for one call. */
function reached(effects: Effect[], operation: string) {
  const found = effects.filter(
    (effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access" &&
      effect.interaction.operation === operation,
  );
  if (found.length === 0) {
    throw new Error(`no storage access for ${operation}`);
  }
  return found.map((effect) => {
    const { semantics, interaction } = storageOf(effect);
    return {
      storageSystem: semantics.storageSystem,
      scope: semantics.scope,
      container: semantics.container,
      kind: interaction.kind,
    };
  });
}

describe("what the pack declares", () => {
  it("reads the gem's two entry constants", () => {
    expect(bigqueryRawSql().map((pattern) => pattern.constantName)).toEqual([
      "Google::Cloud::Bigquery",
      "Google::Cloud",
    ]);
  });

  it("says BigQuery's store and BigQuery's dialect, which are spelled differently", () => {
    const [pattern] = bigqueryRawSql();
    expect(pattern?.storageSystem).toBe("gcp.bigquery");
    expect(pattern?.dialect).toBe("bigquery");
  });

  it("adds itself to a pack without disturbing its discovery", () => {
    const rails: RubyPack = {
      name: "rails",
      protocol: "http",
      discovery: [],
    };
    const composed = withBigquery(rails);
    expect(composed.name).toBe("rails");
    expect(composed.discovery).toBe(rails.discovery);
    expect(composed.rawSql).toHaveLength(2);
  });

  it("keeps a raw SQL pattern the pack already had", () => {
    const already: RubyPack = {
      name: "rails",
      protocol: "http",
      discovery: [],
      rawSql: [
        {
          constantName: "Other::Client",
          clientBuilders: ["connect"],
          storageSystem: "postgresql",
          dialect: "postgresql",
        },
      ],
    };
    expect(withBigquery(already).rawSql).toHaveLength(3);
  });
});

describe("a project that queries BigQuery", () => {
  it("reads a table a constant in another file settles, split into dataset and table", async () => {
    expect(reached(await reportEffects(), "query")).toContainEqual({
      storageSystem: "gcp.bigquery",
      scope: "core",
      container: "dim_account",
      kind: "read",
    });
  });

  it("takes the dataset from the chain when the statement writes a bare table", async () => {
    expect(reached(await reportEffects(), "query")).toContainEqual({
      storageSystem: "gcp.bigquery",
      scope: "core",
      container: "events",
      kind: "read",
    });
  });

  it("reads a statement started as a job", async () => {
    expect(reached(await reportEffects(), "query_job")).toEqual([
      {
        storageSystem: "gcp.bigquery",
        scope: "core",
        container: "dim_account",
        kind: "read",
      },
    ]);
  });

  it("reads an insert onto an addressed table as a write", async () => {
    expect(reached(await reportEffects(), "insert")).toEqual([
      {
        storageSystem: "gcp.bigquery",
        scope: "core",
        container: "report_runs",
        kind: "write",
      },
    ]);
  });

  it("reads dropping a table as a write", async () => {
    expect(reached(await reportEffects(), "delete")).toEqual([
      {
        storageSystem: "gcp.bigquery",
        scope: "core",
        container: "scratch",
        kind: "write",
      },
    ]);
  });

  it("says nothing about a statement handed in from outside", async () => {
    const effects = await reportEffects();
    const tables = effects.flatMap((effect) =>
      effect.type === "interaction" &&
      effect.binding.semantics.name === "storage"
        ? [effect.binding.semantics.container]
        : [],
    );
    expect(tables).not.toContain(null);
  });
});
