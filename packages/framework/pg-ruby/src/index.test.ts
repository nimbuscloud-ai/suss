import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rubyPackUnderTest, storageOf } from "@suss/pack-harness";

import { pgRawSql, pgRubyFramework, withPg } from "./index.js";

import type { RubyPack } from "@suss/adapter-ruby";
import type { Effect } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-pg");

const harness = rubyPackUnderTest(pgRubyFramework());

/** The repository the fixture reads Postgres from, with the rest of the project around it. */
async function repositoryEffects(): Promise<Effect[]> {
  return harness.effectsUnder(
    fixtureRoot,
    "app/repositories/account_repository.rb",
  );
}

/** Every access one call made, as the table, the kind, the columns and the selector. */
function accesses(effects: Effect[], operation: string) {
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
      container: semantics.container,
      kind: interaction.kind,
      fields: interaction.fields,
      selector: interaction.selector ?? [],
    };
  });
}

describe("what the pack declares", () => {
  it("reads both constants the gem hands a connection out from", () => {
    expect(pgRawSql().map((pattern) => pattern.constantName)).toEqual([
      "PG",
      "PG::Connection",
    ]);
  });

  it("takes the statement second for prepare and first for the rest", () => {
    const [pattern] = pgRawSql();
    expect(pattern?.statements?.prepare).toEqual({ at: 1 });
    expect(pattern?.statements?.exec).toEqual({ at: 0 });
  });

  it("adds itself to a pack without disturbing its discovery", () => {
    const rails: RubyPack = { name: "rails", protocol: "http", discovery: [] };
    const composed = withPg(rails);
    expect(composed.name).toBe("rails");
    expect(composed.discovery).toBe(rails.discovery);
    expect(composed.rawSql).toHaveLength(2);
  });
});

describe("a repository that queries Postgres", () => {
  it("reads the columns a parameterised select asks for and what it picks by", async () => {
    expect(accesses(await repositoryEffects(), "exec_params")).toContainEqual({
      storageSystem: "postgresql",
      container: "accounts",
      kind: "read",
      fields: ["id", "name", "tier"],
      selector: ["id"],
    });
  });

  it("keeps the placeholders as placeholders, so an update states its column", async () => {
    expect(accesses(await repositoryEffects(), "exec_params")).toContainEqual({
      storageSystem: "postgresql",
      container: "accounts",
      kind: "write",
      fields: ["name"],
      selector: ["id"],
    });
  });

  it("reads the statement a prepare writes second", async () => {
    expect(accesses(await repositoryEffects(), "prepare")).toEqual([
      {
        storageSystem: "postgresql",
        container: "accounts",
        kind: "read",
        fields: ["id"],
        selector: ["email"],
      },
    ]);
  });

  it("reports every table a join reads", async () => {
    expect(
      accesses(await repositoryEffects(), "async_exec").map(
        (access) => access.container,
      ),
    ).toEqual(["accounts", "plans"]);
  });

  it("says nothing about a statement that touches no table", async () => {
    const operations = (await repositoryEffects()).flatMap((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access"
        ? [effect.interaction.operation]
        : [],
    );
    expect(operations.filter((operation) => operation === "exec")).toHaveLength(
      1,
    );
  });
});
