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
