import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { storageClaims, storageEffects } from "./storage.js";
import { bindEvaluator, methodDefinitionsIn } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RbRawSqlPattern } from "./pack.js";
import type { RbNode } from "./parser.js";

/**
 * A store library written the way a pack writes one: a connect call on
 * its own constant, calls that take a statement in three places, and
 * calls that reach rows with no statement. None of these strings appear
 * in the adapter's own source.
 */
const STORE: RbRawSqlPattern = {
  constantName: "Warehouse::Client",
  clientBuilders: ["connect"],
  addressing: {
    area: { says: "scope", at: 0 },
    table: { says: "container", at: 0 },
  },
  statements: {
    run: { at: 0 },
    run_named: { at: 1 },
    ask: { at: 0, keyword: "statement" },
  },
  rowCalls: {
    append: { kind: "write" },
    rows: { kind: "read" },
    put: { kind: "write", container: { at: 0 } },
  },
  storageSystem: "postgresql",
  dialect: "postgresql",
};

/** The same library over a store that writes namespaces in front of a table. */
const QUALIFIED: RbRawSqlPattern = {
  ...STORE,
  storageSystem: "warehouse.cloud",
  dialect: "bigquery",
};

function callsIn(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }

    if (child.type === "call") {
      found.push(child);
    }
    callsIn(child, found);
  }
  return found;
}

const FILE = "app/jobs/rollup_job.rb";

/** The facts a run over these files would have, and the parsed body of the last one. */
async function factsFor(files: Record<string, string>) {
  const db = new Database();
  const parsed: Array<{ file: string; root: RbNode }> = [];
  const constants = [];
  for (const [file, source] of Object.entries(files)) {
    const tree = await parseRuby(source);
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode, []));
    parsed.push({ file, root: tree.rootNode });
  }
  emitConstantBindings(db, constants);
  const definitions = new Map(
    parsed.flatMap(({ file, root }) => [...methodDefinitionsIn(file, root)]),
  );
  bindEvaluator(db, { files: parsed, definitions });
  return { db, root: parsed[parsed.length - 1]?.root as RbNode };
}

async function effectsFor(
  source: string,
  pattern: RbRawSqlPattern = STORE,
  other: Record<string, string> = {},
): Promise<Effect[]> {
  const { db, root } = await factsFor({ ...other, [FILE]: source });
  return storageEffects(callsIn(root), FILE, {
    facts: db,
    patterns: [],
    rawSql: [pattern],
  });
}

/** The storage access an effect is, or a throw saying what it was instead. */
function storageIn(effect: Effect | undefined) {
  if (effect === undefined || effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect?.type}`);
  }

  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected a storage boundary, got ${semantics.name}`);
  }

  const interaction = effect.interaction;
  if (interaction.class !== "storage-access") {
    throw new Error(`expected storage access, got ${interaction.class}`);
  }
  return { semantics, interaction };
}

/** The store, the namespace and the container one effect reached. */
function reached(effect: Effect | undefined) {
  const { semantics } = storageIn(effect);
  return {
    storageSystem: semantics.storageSystem,
    scope: semantics.scope,
    container: semantics.container,
  };
}

/** What one effect says was done to the rows. */
function access(effect: Effect | undefined) {
  const { interaction } = storageIn(effect);
  return {
    kind: interaction.kind,
    fields: interaction.fields,
    selector: interaction.selector ?? [],
  };
}

/** A body that connects and then runs one statement. */
function connected(...statements: string[]): string {
  return [
    "class RollupJob",
    "  def run",
    '    conn = Warehouse::Client.connect(url: ENV["WAREHOUSE_URL"])',
    ...statements.map((line) => `    ${line}`),
    "  end",
    "end",
    "",
  ].join("\n");
}

describe("a call that takes a statement", () => {
  it("reads the tables the statement touches", async () => {
    const effects = await effectsFor(
      connected('conn.run("SELECT id, name FROM accounts WHERE tier = $1")'),
    );

    expect(effects).toHaveLength(1);
    expect(reached(effects[0])).toEqual({
      storageSystem: "postgresql",
      scope: "default",
      container: "accounts",
    });
    expect(access(effects[0])).toEqual({
      kind: "read",
      fields: ["id", "name"],
      selector: ["tier"],
    });
  });

  it("reads a write as a write, with the columns it sets", async () => {
    const effects = await effectsFor(
      connected('conn.run("UPDATE accounts SET tier = $2 WHERE id = $1")'),
    );

    expect(access(effects[0])).toEqual({
      kind: "write",
      fields: ["tier"],
      selector: ["id"],
    });
  });

  it("reads the statement from the position the pack stated", async () => {
    const effects = await effectsFor(
      connected('conn.run_named("recent", "SELECT id FROM accounts")'),
    );

    expect(reached(effects[0]).container).toBe("accounts");
  });

  it("reads the statement from the keyword the pack stated", async () => {
    const effects = await effectsFor(
      connected('conn.ask(statement: "SELECT id FROM accounts")'),
    );

    expect(reached(effects[0]).container).toBe("accounts");
  });

  it("reports every table a join reads", async () => {
    const effects = await effectsFor(
      connected(
        'conn.run("SELECT a.id FROM accounts a JOIN plans p ON p.id = a.plan_id")',
      ),
    );

    expect(effects.map((effect) => reached(effect).container)).toEqual([
      "accounts",
      "plans",
    ]);
  });

  it("says nothing about a statement that touches no table", async () => {
    expect(await effectsFor(connected('conn.run("BEGIN")'))).toEqual([]);
  });

  it("says nothing about a call on a receiver the library never gave out", async () => {
    const source = [
      "class RollupJob",
      "  def run",
      "    other = SomethingElse.new",
      '    other.run("SELECT id FROM accounts")',
      "  end",
      "end",
      "",
    ].join("\n");

    expect(await effectsFor(source)).toEqual([]);
  });

  it("says nothing about a method the library does not define", async () => {
    expect(
      await effectsFor(connected('conn.explain("SELECT id FROM accounts")')),
    ).toEqual([]);
  });

  it("says nothing about a call with no receiver at all", async () => {
    expect(
      await effectsFor(connected('run("SELECT id FROM accounts")')),
    ).toEqual([]);
  });

  it("says nothing about a call given no statement", async () => {
    expect(await effectsFor(connected("conn.run"))).toEqual([]);
  });

  it("says nothing about an addressing call on a receiver the library never gave out", async () => {
    const source = [
      "class RollupJob",
      "  def run",
      '    Elsewhere.table("accounts").append(rows)',
      "  end",
      "end",
      "",
    ].join("\n");

    expect(await effectsFor(source, QUALIFIED)).toEqual([]);
  });

  it("says nothing about a row call given no table where the chain said none", async () => {
    expect(await effectsFor(connected("conn.put"), QUALIFIED)).toEqual([]);
  });
});

describe("a statement the code builds", () => {
  it("keeps an interpolated value as a parameter", async () => {
    const effects = await effectsFor(
      connected(
        "id = params[:id]",
        'conn.run("SELECT name FROM accounts WHERE id = #{id}")',
      ),
    );

    expect(reached(effects[0]).container).toBe("accounts");
    expect(access(effects[0]).selector).toEqual(["id"]);
  });

  it("reads a table a constant in another file settles", async () => {
    const effects = await effectsFor(
      connected('conn.run("SELECT id FROM #{Tables::ACCOUNTS}")'),
      STORE,
      {
        "app/models/tables.rb": [
          "module Tables",
          '  ACCOUNTS = "accounts"',
          "end",
          "",
        ].join("\n"),
      },
    );

    expect(reached(effects[0]).container).toBe("accounts");
  });

  it("reads a table a constant reached through another module settles", async () => {
    const effects = await effectsFor(
      connected('conn.run("SELECT id FROM #{ACCOUNTS_TABLE}")'),
      STORE,
      {
        "app/models/tables.rb": [
          "module Tables",
          '  ACCOUNTS = "accounts"',
          "end",
          "",
          "ACCOUNTS_TABLE = Tables::ACCOUNTS",
          "",
        ].join("\n"),
      },
    );

    expect(reached(effects[0]).container).toBe("accounts");
  });

  it("says nothing when the table itself is a value nobody settled", async () => {
    const effects = await effectsFor(
      connected(
        "table = params[:table]",
        'conn.run("SELECT id FROM #{table}")',
      ),
    );

    expect(effects).toEqual([]);
  });

  it("says nothing when the whole statement is a value nobody settled", async () => {
    expect(await effectsFor(connected("conn.run(params[:sql])"))).toEqual([]);
  });
});

describe("a store whose table names carry their namespace", () => {
  it("reports the last part as the container and the one before it as the scope", async () => {
    const effects = await effectsFor(
      connected('conn.run("SELECT id FROM `warehouse-prod.core.accounts`")'),
      QUALIFIED,
    );

    expect(reached(effects[0])).toEqual({
      storageSystem: "warehouse.cloud",
      scope: "core",
      container: "accounts",
    });
  });

  it("takes the scope from the chain when the statement writes a bare table", async () => {
    const effects = await effectsFor(
      connected('conn.area("core").run("SELECT id FROM accounts")'),
      QUALIFIED,
    );

    expect(reached(effects[0])).toEqual({
      storageSystem: "warehouse.cloud",
      scope: "core",
      container: "accounts",
    });
  });
});

describe("a call that reaches rows with no statement", () => {
  it("reports the container the chain addressed", async () => {
    const effects = await effectsFor(
      connected('conn.area("core").table("accounts").append(rows)'),
      QUALIFIED,
    );

    expect(reached(effects[0])).toEqual({
      storageSystem: "warehouse.cloud",
      scope: "core",
      container: "accounts",
    });
    expect(access(effects[0]).kind).toBe("write");
  });

  it("reads the container off a call given it rather than made on it", async () => {
    const effects = await effectsFor(
      connected('conn.area("core").put("accounts", rows)'),
      QUALIFIED,
    );

    expect(reached(effects[0]).container).toBe("accounts");
  });

  it("falls back to the chain's container when that argument is not a table", async () => {
    const effects = await effectsFor(
      connected('conn.area("core").table("accounts").put(rows)'),
      QUALIFIED,
    );

    expect(reached(effects[0]).container).toBe("accounts");
  });

  it("follows a client kept in an instance variable", async () => {
    const source = [
      "class RollupJob",
      "  def initialize",
      "    @conn = Warehouse::Client.connect",
      "  end",
      "",
      "  def run",
      '    @conn.table("accounts").rows',
      "  end",
      "end",
      "",
    ].join("\n");
    const effects = await effectsFor(source);

    expect(reached(effects[0]).container).toBe("accounts");
    expect(access(effects[0]).kind).toBe("read");
  });

  it("says nothing when nothing settled which container it reached", async () => {
    const effects = await effectsFor(
      connected("name = params[:table]", "conn.table(name).append(rows)"),
    );

    expect(effects).toEqual([]);
  });
});

describe("a call the raw SQL reader records", () => {
  it("is claimed, so the reach walk does not report it as a gap", async () => {
    const { db, root } = await factsFor({
      [FILE]: connected('conn.run("SELECT id FROM accounts")'),
    });
    const claimed = callsIn(root).filter((call) =>
      storageClaims(call, FILE, { facts: db, patterns: [], rawSql: [STORE] }),
    );

    expect(claimed).toHaveLength(1);
  });
});
