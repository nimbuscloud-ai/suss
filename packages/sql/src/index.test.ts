import { describe, expect, it } from "vitest";

import { readSqlAccess, splitQualifiedTable, sqlFromParts } from "./index.js";

describe("what a statement touches", () => {
  it("reads the table, the fields, and what a select picks rows by", () => {
    expect(
      readSqlAccess(
        "SELECT id, email FROM users WHERE tenant_id = $1 AND status = 'active'",
      ),
    ).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "read",
        fields: ["id", "email"],
        selector: ["tenant_id", "status"],
      },
    ]);
  });

  it("reads a whole row as the wildcard the pairing pass takes", () => {
    expect(readSqlAccess("SELECT * FROM users")).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "read",
        fields: ["*"],
        selector: [],
      },
    ]);
  });

  it("gives a join one access per table, each with its own fields", () => {
    expect(
      readSqlAccess(
        "SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE o.status = $1",
      ),
    ).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "read",
        fields: ["id"],
        selector: [],
      },
      {
        table: "orders",
        qualifier: [],
        kind: "read",
        fields: ["total"],
        selector: ["status"],
      },
    ]);
  });

  it("leaves an unqualified field out of a join, since nothing says which table it is on", () => {
    const [users, orders] = readSqlAccess(
      "SELECT id FROM users u JOIN orders o ON o.user_id = u.id",
    );
    expect(users.fields).toEqual([]);
    expect(orders.fields).toEqual([]);
  });

  it("reads the columns an insert writes", () => {
    expect(
      readSqlAccess("INSERT INTO users (id, email) VALUES ($1, $2)"),
    ).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "write",
        fields: ["id", "email"],
        selector: [],
      },
    ]);
  });

  it("reads what an update sets and what it picks rows by", () => {
    expect(readSqlAccess("UPDATE users SET email = $1 WHERE id = $2")).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "write",
        fields: ["email"],
        selector: ["id"],
      },
    ]);
  });

  it("reads a delete as a write that states no fields", () => {
    expect(
      readSqlAccess("DELETE FROM sessions WHERE expires_at < NOW()"),
    ).toEqual([
      {
        table: "sessions",
        qualifier: [],
        kind: "write",
        fields: [],
        selector: ["expires_at"],
      },
    ]);
  });

  it("reads each statement of a script", () => {
    expect(
      readSqlAccess("SELECT id FROM users; DELETE FROM sessions").map(
        (access) => access.table,
      ),
    ).toEqual(["users", "sessions"]);
  });

  it("reads the tables inside a WITH clause, not the names it gives them", () => {
    expect(
      readSqlAccess(
        "WITH recent AS (SELECT id, tenant_id FROM searchable WHERE tenant_id = $1) SELECT r.id FROM recent r",
      ),
    ).toEqual([
      {
        table: "searchable",
        qualifier: [],
        kind: "read",
        fields: ["id", "tenant_id"],
        selector: ["tenant_id"],
      },
    ]);
  });

  it("reads every table a WITH clause of several queries touches", () => {
    expect(
      readSqlAccess(
        "WITH terms AS (SELECT q FROM queries), rows AS (SELECT id FROM searchable) SELECT r.id FROM rows r, terms t",
      ).map((access) => access.table),
    ).toEqual(["queries", "searchable"]);
  });

  it("reads a WITH clause beside a table the outer query reads itself", () => {
    expect(
      readSqlAccess(
        "WITH recent AS (SELECT id FROM searchable) SELECT r.id, u.email FROM recent r JOIN users u ON u.id = r.id",
      ).map((access) => access.table),
    ).toEqual(["users", "searchable"]);
  });

  it("reads a WITH clause that feeds another one", () => {
    expect(
      readSqlAccess(
        "WITH a AS (SELECT id FROM searchable), b AS (SELECT id FROM a) SELECT id FROM b",
      ).map((access) => access.table),
    ).toEqual(["searchable"]);
  });

  it("does not report a select that reads from nothing", () => {
    expect(readSqlAccess("SELECT 1")).toEqual([]);
    expect(readSqlAccess("SELECT NOW()")).toEqual([]);
  });

  it("reads an insert without a column list as a write that states no fields", () => {
    expect(readSqlAccess("INSERT INTO users VALUES ($1, $2)")).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "write",
        fields: [],
        selector: [],
      },
    ]);
  });

  it("does not report a select whose FROM is a subquery", () => {
    expect(
      readSqlAccess("SELECT total FROM (SELECT 1 AS total) recent"),
    ).toEqual([]);
  });

  it("says nothing about a statement it cannot read", () => {
    expect(readSqlAccess("this is not sql")).toEqual([]);
    expect(readSqlAccess("SELECT FROM WHERE")).toEqual([]);
  });

  it("says nothing about a dialect it does not read", () => {
    expect(
      readSqlAccess("SELECT id FROM users", { dialect: "cassandra" }),
    ).toEqual([]);
  });
});

describe("a parameter written with the type it is read as", () => {
  it("reads the table either side of a cast", () => {
    expect(
      readSqlAccess(
        "UPDATE dim_account SET status = $1::text WHERE id = $2::integer",
      ),
    ).toEqual([
      {
        table: "dim_account",
        qualifier: [],
        kind: "write",
        fields: ["status"],
        selector: ["id"],
      },
    ]);
  });

  it("reads a cast to an array type", () => {
    expect(
      readSqlAccess("SELECT id FROM dim_account WHERE id = ANY($1::int[])"),
    ).toEqual([
      {
        table: "dim_account",
        qualifier: [],
        kind: "read",
        fields: ["id"],
        selector: ["id"],
      },
    ]);
  });

  it("reads a cast to a type the standard spells in several words", () => {
    expect(
      readSqlAccess(
        "SELECT id FROM dim_account WHERE seen_at = $1::timestamp with time zone",
      )[0]?.selector,
    ).toEqual(["seen_at"]);
  });

  it("reads a cast to a type a schema states, and one given a width", () => {
    expect(
      readSqlAccess("SELECT id FROM dim_account WHERE s = $1::public.state")[0]
        ?.table,
    ).toBe("dim_account");
    expect(
      readSqlAccess("SELECT id FROM dim_account WHERE s = $1::varchar(20)")[0]
        ?.table,
    ).toBe("dim_account");
  });

  it("reads a cast whose type the statement quotes", () => {
    expect(
      readSqlAccess('SELECT id FROM dim_account WHERE id = $1::"AccountId"')[0]
        ?.table,
    ).toBe("dim_account");
  });

  it("leaves a cast written inside a quoted name alone", () => {
    expect(
      readSqlAccess('SELECT id FROM "dim$1::text" WHERE id = $2::integer')[0]
        ?.table,
    ).toBe("dim$1::text");
  });
});

describe("a select that locks the rows it picks", () => {
  it("reads one that waits for the rows", () => {
    expect(
      readSqlAccess("SELECT id FROM jobs WHERE run_at < now() FOR UPDATE"),
    ).toEqual([
      {
        table: "jobs",
        qualifier: [],
        kind: "read",
        fields: ["id"],
        selector: ["run_at"],
      },
    ]);
  });

  it("reads one that steps over a row somebody else took", () => {
    expect(
      readSqlAccess("SELECT id FROM jobs FOR UPDATE SKIP LOCKED")[0]?.table,
    ).toBe("jobs");
    expect(
      readSqlAccess("SELECT id FROM jobs FOR SHARE NOWAIT")[0]?.table,
    ).toBe("jobs");
  });

  it("reads one that says which table it locks", () => {
    expect(
      readSqlAccess(
        "SELECT j.id FROM jobs j JOIN queues q ON q.id = j.queue_id FOR NO KEY UPDATE OF j",
      ).map((access) => access.table),
    ).toEqual(["jobs", "queues"]);
  });
});

describe("a WITH clause in front of a write", () => {
  it("reads the insert and the tables the clause feeds it from", () => {
    expect(
      readSqlAccess(
        "WITH due AS (SELECT id FROM jobs WHERE run_at < now() FOR UPDATE SKIP LOCKED) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ),
    ).toEqual([
      {
        table: "job_runs",
        qualifier: [],
        kind: "write",
        fields: ["job_id"],
        selector: [],
      },
      {
        table: "jobs",
        qualifier: [],
        kind: "read",
        fields: ["id"],
        selector: ["run_at"],
      },
    ]);
  });

  it("reads the same clause in front of a delete", () => {
    expect(
      readSqlAccess(
        "WITH stale AS (SELECT id FROM jobs) DELETE FROM job_runs WHERE id IN (SELECT id FROM stale)",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads the same clause in front of an update", () => {
    expect(
      readSqlAccess(
        "WITH due AS (SELECT id FROM jobs) UPDATE job_runs SET state = $1 FROM due WHERE job_runs.id = due.id",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("does not report a name the clause gives one of its own queries", () => {
    expect(
      readSqlAccess(
        "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM a) INSERT INTO job_runs (job_id) SELECT id FROM b",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "orders"]);
  });

  it("reads a clause that says how it is evaluated, or names its columns", () => {
    expect(
      readSqlAccess(
        "WITH due AS MATERIALIZED (SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
    expect(
      readSqlAccess(
        "WITH due (job_id) AS (SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT job_id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads a clause whose name the statement quotes", () => {
    expect(
      readSqlAccess(
        'WITH "due rows" AS (SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT id FROM "due rows"',
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads a parenthesis inside a literal as text rather than as the end of the clause", () => {
    expect(
      readSqlAccess(
        "WITH due AS (SELECT id FROM jobs WHERE note = ')') INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads a clause a comment runs through", () => {
    expect(
      readSqlAccess(
        "WITH due AS ( -- the ones that are ready\n SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads a recursive clause", () => {
    expect(
      readSqlAccess(
        "WITH RECURSIVE tree AS (SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT id FROM tree",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads a parenthesis inside a dollar-quoted literal as text too", () => {
    expect(
      readSqlAccess(
        "WITH due AS (SELECT id FROM jobs WHERE note = $tag$ ) $tag$) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
    expect(
      readSqlAccess(
        "WITH due AS (SELECT id FROM jobs WHERE note = $$ ) $$) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("reads a clause a comment interrupts before the name", () => {
    expect(
      readSqlAccess(
        "WITH /* the ones that are ready */ due AS (SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
    expect(
      readSqlAccess(
        "-- a note\nWITH due AS (SELECT id FROM jobs) INSERT INTO job_runs (job_id) SELECT id FROM due",
      ).map((access) => access.table),
    ).toEqual(["job_runs", "jobs"]);
  });

  it("says nothing about a clause nothing closes", () => {
    expect(readSqlAccess("WITH due AS (SELECT id FROM jobs")).toEqual([]);
  });

  it("says nothing about a clause that states no name, or never says AS", () => {
    expect(
      readSqlAccess(
        "WITH (SELECT id FROM jobs) INSERT INTO job_runs (job_id) VALUES ($1)",
      ),
    ).toEqual([]);
    expect(readSqlAccess("WITH due SELECT id FROM jobs")).toEqual([]);
  });

  it("says nothing about a clause whose query is not parenthesised", () => {
    expect(
      readSqlAccess(
        "WITH due AS SELECT id FROM jobs INSERT INTO job_runs (job_id) VALUES ($1)",
      ),
    ).toEqual([]);
  });
});

describe("a kind of statement it does not read", () => {
  it("says nothing about one that parses but touches no rows", () => {
    expect(readSqlAccess("CREATE TABLE dim_account (id int)")).toEqual([]);
  });
});

describe("a query a FROM writes in place of a table", () => {
  it("reads the tables inside it", () => {
    expect(
      readSqlAccess(
        "SELECT dc.account_id, count(*) FROM (SELECT account_id FROM dim_contact WHERE active) dc JOIN dim_account a ON a.id = dc.account_id",
      ),
    ).toEqual([
      {
        table: "dim_account",
        qualifier: [],
        kind: "read",
        fields: [],
        selector: [],
      },
      {
        table: "dim_contact",
        qualifier: [],
        kind: "read",
        fields: ["account_id"],
        selector: ["active"],
      },
    ]);
  });

  it("drops a column read through its alias, which names no base table", () => {
    const [account] = readSqlAccess(
      "SELECT dc.account_id FROM (SELECT account_id FROM dim_contact) dc JOIN dim_account a ON a.id = dc.account_id",
    );
    expect(account?.table).toBe("dim_account");
    expect(account?.fields).toEqual([]);
  });

  it("leaves an unqualified column out, since the query could have supplied it", () => {
    const [account] = readSqlAccess(
      "SELECT account_id FROM (SELECT account_id FROM dim_contact) dc JOIN dim_account a ON a.id = dc.account_id",
    );
    expect(account?.fields).toEqual([]);
  });

  it("reads one that is the only thing the FROM states", () => {
    expect(
      readSqlAccess(
        "SELECT s.total FROM (SELECT sum(amount) AS total FROM orders WHERE paid) s",
      ),
    ).toEqual([
      {
        table: "orders",
        qualifier: [],
        kind: "read",
        fields: ["amount"],
        selector: ["paid"],
      },
    ]);
  });

  it("reads one written inside another", () => {
    expect(
      readSqlAccess(
        "SELECT x.id FROM (SELECT y.id FROM (SELECT id FROM orders) y) x",
      ).map((access) => access.table),
    ).toEqual(["orders"]);
  });

  it("reads one that reads from a WITH clause, without reporting the name", () => {
    expect(
      readSqlAccess(
        "WITH c AS (SELECT id FROM refunds) SELECT d.id FROM (SELECT id FROM c) d JOIN orders o ON o.id = d.id",
      ).map((access) => access.table),
    ).toEqual(["orders", "refunds"]);
  });
});

describe("a query written as a tagged template", () => {
  it("reads an interpolation as the parameter it becomes", () => {
    const sql = sqlFromParts(["SELECT id FROM users WHERE tenant = ", ""]);
    expect(sql).toBe("SELECT id FROM users WHERE tenant = $1");
    expect(readSqlAccess(sql)).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "read",
        fields: ["id"],
        selector: ["tenant"],
      },
    ]);
  });

  it("numbers each interpolation in the order the query writes them", () => {
    expect(
      sqlFromParts(["UPDATE users SET email = ", " WHERE id = ", ""]),
    ).toBe("UPDATE users SET email = $1 WHERE id = $2");
  });

  it("reads a template with nothing interpolated as itself", () => {
    expect(sqlFromParts(["SELECT 1"])).toBe("SELECT 1");
  });
});

describe("a hole the source settled", () => {
  it("writes it into a quoted name", () => {
    const sql = sqlFromParts(
      ["SELECT id FROM `", "`"],
      [],
      ["analytics-prod.core.dim_account"],
    );

    expect(sql).toBe("SELECT id FROM `analytics-prod.core.dim_account`");
    expect(readSqlAccess(sql, { dialect: "bigquery" })).toEqual([
      {
        table: "dim_account",
        qualifier: ["analytics-prod", "core"],
        kind: "read",
        fields: ["id"],
        selector: [],
      },
    ]);
  });

  it("leaves a value position as a parameter, so a constant stays a selector", () => {
    const sql = sqlFromParts(
      ["SELECT id FROM users WHERE tier = ", ""],
      [],
      ["gold"],
    );

    expect(sql).toBe("SELECT id FROM users WHERE tier = $1");
    expect(readSqlAccess(sql)[0]?.selector).toEqual(["tier"]);
  });

  it("keeps a name a double quote opened apart from one it closed", () => {
    expect(
      sqlFromParts(['SELECT id FROM "', '" WHERE tier = ', ""], [], ["a", "b"]),
    ).toBe('SELECT id FROM "a" WHERE tier = $2');
  });

  it("drops a part of a name nothing settled, and keeps the table", () => {
    const sql = sqlFromParts(
      ["SELECT id FROM `", ".", ".dim_account`"],
      [],
      [],
    );

    expect(sql).toBe("SELECT id FROM `$1.$2.dim_account`");
    expect(readSqlAccess(sql, { dialect: "bigquery" })).toEqual([
      {
        table: "dim_account",
        qualifier: [],
        kind: "read",
        fields: ["id"],
        selector: [],
      },
    ]);
  });

  it("says nothing about a table nothing settled at all", () => {
    const sql = sqlFromParts(["SELECT id FROM `", "`"], [], []);

    expect(readSqlAccess(sql, { dialect: "bigquery" })).toEqual([]);
  });

  it("keeps the dataset when only the project was built at run time", () => {
    const sql = sqlFromParts(
      ["SELECT id FROM `", ".core.dim_account`"],
      [],
      [],
    );

    expect(sql).toBe("SELECT id FROM `$1.core.dim_account`");
    expect(readSqlAccess(sql, { dialect: "bigquery" })).toEqual([
      {
        table: "dim_account",
        qualifier: ["core"],
        kind: "read",
        fields: ["id"],
        selector: [],
      },
    ]);
  });
});

describe("a hole the statement writes a table name into", () => {
  it("reads an unquoted table after FROM", () => {
    const sql = sqlFromParts(
      ["SELECT id FROM ", " WHERE id = $1"],
      [],
      ["users"],
    );

    expect(sql).toBe("SELECT id FROM users WHERE id = $1");
    expect(readSqlAccess(sql)[0]).toMatchObject({
      table: "users",
      kind: "read",
      fields: ["id"],
    });
  });

  it("reads the second table of a join out of a hole after JOIN", () => {
    const sql = sqlFromParts(
      ["SELECT u.id, o.total FROM users u JOIN ", " o ON o.user_id = u.id"],
      [],
      ["orders"],
    );

    expect(readSqlAccess(sql).map((access) => access.table)).toEqual([
      "users",
      "orders",
    ]);
  });

  it("leaves a hole after WHERE the parameter it was", () => {
    const sql = sqlFromParts(
      ["SELECT id FROM users WHERE tier = ", ""],
      [],
      ["gold"],
    );

    expect(sql).toBe("SELECT id FROM users WHERE tier = $1");
    expect(readSqlAccess(sql)[0]?.selector).toEqual(["tier"]);
  });

  it("says nothing where the table after FROM settled nothing", () => {
    const sql = sqlFromParts(["SELECT id FROM ", ""], [], []);

    expect(sql).toBe("SELECT id FROM $1");
    expect(readSqlAccess(sql)).toEqual([]);
  });
});

describe("a table name a caller read off an argument", () => {
  it("splits it the way a table in a statement is split", () => {
    expect(splitQualifiedTable("analytics-prod.core.dim_account")).toEqual({
      table: "dim_account",
      qualifier: ["analytics-prod", "core"],
    });
  });

  it("gives a bare name no qualifier", () => {
    expect(splitQualifiedTable("dim_account")).toEqual({
      table: "dim_account",
      qualifier: [],
    });
  });

  it("drops a namespace nothing settled and keeps the table", () => {
    expect(splitQualifiedTable("$1.$2.dim_account")).toEqual({
      table: "dim_account",
      qualifier: [],
    });
  });

  it("stops at the first unsettled part, reading outward from the table", () => {
    expect(splitQualifiedTable("analytics.$1.dim_account")?.qualifier).toEqual(
      [],
    );
  });

  it("keeps a dataset the source settled when only the project is unsettled", () => {
    expect(splitQualifiedTable("$1.core.dim_account")?.qualifier).toEqual([
      "core",
    ]);
  });

  it("keeps both namespaces when the source settled the whole name", () => {
    expect(
      splitQualifiedTable("analytics.core.dim_account")?.qualifier,
    ).toEqual(["analytics", "core"]);
  });

  it("says nothing about a table nothing settled", () => {
    expect(splitQualifiedTable("$1")).toBeNull();
  });
});

describe("the dialects it reads", () => {
  it("reads MySQL, where a name is quoted with backticks", () => {
    expect(
      readSqlAccess("SELECT `id`, `email` FROM `users` WHERE tenant_id = ?", {
        dialect: "mysql",
      }),
    ).toEqual([
      {
        table: "users",
        qualifier: [],
        kind: "read",
        fields: ["id", "email"],
        selector: ["tenant_id"],
      },
    ]);
  });

  it("reads SQLite", () => {
    expect(
      readSqlAccess("INSERT INTO sessions (id, expires_at) VALUES (?, ?)", {
        dialect: "sqlite",
      }),
    ).toEqual([
      {
        table: "sessions",
        qualifier: [],
        kind: "write",
        fields: ["id", "expires_at"],
        selector: [],
      },
    ]);
  });

  it("reads BigQuery, splitting the project and the dataset off the table", () => {
    expect(
      readSqlAccess(
        "SELECT event_name FROM `proj.dataset.events` WHERE event_date = @d",
        { dialect: "bigquery" },
      ),
    ).toEqual([
      {
        table: "events",
        qualifier: ["proj", "dataset"],
        kind: "read",
        fields: ["event_name"],
        selector: ["event_date"],
      },
    ]);
  });

  it("reads a BigQuery table written with its dataset and no project", () => {
    const [access] = readSqlAccess("SELECT id FROM `core.dim_account`", {
      dialect: "bigquery",
    });
    expect(access).toMatchObject({
      table: "dim_account",
      qualifier: ["core"],
    });
  });

  it("reads a BigQuery delete, whose grammar puts the table in the alias", () => {
    expect(
      readSqlAccess("DELETE FROM `proj.dataset.events` WHERE id = @id", {
        dialect: "bigquery",
      }),
    ).toEqual([
      {
        table: "events",
        qualifier: ["proj", "dataset"],
        kind: "write",
        fields: [],
        selector: ["id"],
      },
    ]);
  });

  it("reads Postgres under the one name the store goes by", () => {
    const [access] = readSqlAccess("SELECT id FROM users", {
      dialect: "postgresql",
    });
    expect(access.table).toBe("users");
    expect(
      readSqlAccess("SELECT id FROM users", { dialect: "postgres" }),
    ).toEqual([]);
  });
});
