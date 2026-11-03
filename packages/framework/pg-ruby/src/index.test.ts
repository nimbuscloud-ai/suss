import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rubyPackUnderTest, storageOf } from "@suss/pack-harness";

import { pgRubyFramework, withPg } from "./index.js";

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

/** The tables a method reads, run over the lines given. */
async function tablesRead(...lines: string[]): Promise<(string | null)[]> {
  const effects = await harness.effectsAcross(
    {
      "repo.rb": ["class Repo", "  def run", ...lines, "  end", "end"].join(
        "\n",
      ),
    },
    "repo.rb",
  );
  return effects.map((effect) => storageOf(effect).semantics.container);
}

describe("which connections the pack reads", () => {
  it("reads a connection from PG.connect and from each builder on PG::Connection", async () => {
    expect(
      await tablesRead(
        '    a = PG.connect("x")',
        '    a.exec("SELECT id FROM accounts")',
        '    b = PG::Connection.new("x")',
        '    b.exec("SELECT id FROM plans")',
        '    c = PG::Connection.open("x")',
        '    c.exec("SELECT id FROM teams")',
        '    d = ::PG::Connection.connect("x")',
        '    d.exec("SELECT id FROM users")',
      ),
    ).toEqual(["accounts", "plans", "teams", "users"]);
  });

  it("leaves alone a receiver another library or another PG class made", async () => {
    expect(
      await tablesRead(
        '    a = Sequel.connect("x")',
        '    a.exec("SELECT id FROM accounts")',
        "    b = PG::TextEncoder::Array.new",
        '    b.exec("SELECT id FROM plans")',
      ),
    ).toEqual([]);
  });

  it("takes the statement second for prepare and first for the rest", async () => {
    expect(
      await tablesRead(
        '    conn = PG.connect("x")',
        '    conn.prepare("by_id", "SELECT id FROM accounts WHERE id = $1")',
        '    conn.exec("SELECT id FROM plans")',
      ),
    ).toEqual(["accounts", "plans"]);
  });

  it("adds itself to a pack without disturbing its discovery", () => {
    const rails: RubyPack = { name: "rails", protocol: "http", discovery: [] };
    const composed = withPg(rails);
    expect(composed.name).toBe("rails");
    expect(composed.discovery).toBe(rails.discovery);
    expect(composed.accessRecognizers?.length).toBeGreaterThan(0);
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
