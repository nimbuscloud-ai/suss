import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  railsSchemaFileToSummaries,
  railsSchemaToSummaries,
  structureSqlToSummaries,
} from "./index.js";

import type {
  BehavioralSummary,
  StorageContractMetadata,
} from "@suss/behavioral-ir";

type Field = NonNullable<StorageContractMetadata["fields"]>[number];

function fieldsOf(summary: BehavioralSummary | undefined): Field[] {
  const contract = summary?.metadata?.storageContract as
    | StorageContractMetadata
    | undefined;
  return contract?.fields ?? [];
}

/** The columns of each table a schema.rb declares, keyed by table. */
async function tables(source: string): Promise<Record<string, Field[]>> {
  const summaries = await railsSchemaToSummaries(source);
  return Object.fromEntries(
    summaries.map((summary) => [summary.identity.name, fieldsOf(summary)]),
  );
}

function schema(body: string): string {
  return `ActiveRecord::Schema[7.1].define(version: 2024_06_01_000000) do\n${body}\nend\n`;
}

describe("the key create_table adds", () => {
  it("is a bigint id drawing on a sequence when nothing says otherwise", async () => {
    const read = await tables(
      schema(`  create_table "users", force: :cascade do |t|\n  end`),
    );
    expect(read.users).toEqual([
      {
        name: "id",
        type: "bigint",
        nullable: false,
        primary: true,
        default: true,
      },
    ]);
  });

  it("takes its type from id:, and has a default only where the dump writes one", async () => {
    const read = await tables(
      schema(`
  create_table "a", id: :uuid, default: -> { "gen_random_uuid()" } do |t|
  end
  create_table "b", id: :uuid do |t|
  end
  create_table "c", id: :serial do |t|
  end
  create_table "d", id: { type: :string, limit: 36 } do |t|
  end
  create_table "e", id: :integer, default: nil do |t|
  end
  create_table "f", id: :string, primary_key: "code" do |t|
  end`),
    );
    const keyOf = (table: string) => {
      const [key] = read[table] ?? [];
      return [key?.name, key?.type, key?.default];
    };
    expect(keyOf("a")).toEqual(["id", "uuid", true]);
    expect(keyOf("b")).toEqual(["id", "uuid", false]);
    expect(keyOf("c")).toEqual(["id", "serial", true]);
    expect(keyOf("d")).toEqual(["id", "string", false]);
    expect(keyOf("e")).toEqual(["id", "integer", false]);
    expect(keyOf("f")).toEqual(["code", "string", false]);
  });

  it("is left out with id: false, and a composite key comes from primary_key: [...]", async () => {
    const read = await tables(
      schema(`
  create_table "tags_posts", id: false do |t|
    t.bigint "tag_id"
  end
  create_table "memberships", primary_key: ["user_id", "group_id"] do |t|
    t.bigint "user_id", null: false
    t.bigint "group_id", null: false
    t.string "role"
  end
  create_table "pairs", id: false, primary_key: ["a", "b"] do |t|
    t.integer "a", null: false
    t.integer "b", null: false
  end`),
    );
    expect(read.tags_posts?.map((column) => column.name)).toEqual(["tag_id"]);
    expect(
      read.memberships?.map((column) => [column.name, column.primary]),
    ).toEqual([
      ["user_id", true],
      ["group_id", true],
      ["role", undefined],
    ]);
    expect(read.pairs?.every((column) => column.primary === true)).toBe(true);
  });
});

describe("the columns a create_table block declares", () => {
  it("reads null:, default:, limit: and array: on a typed column", async () => {
    const read = await tables(
      schema(`
  create_table "orders", force: :cascade do |t|
    t.string "status", default: "pending", null: false
    t.integer "quantity", limit: 2, null: false
    t.integer "total_cents", limit: 8
    t.integer "flags", limit: 1
    t.integer "priority", null: false
    t.string "tags", default: [], null: false, array: true
    t.text "notes", default: nil
    t.datetime "shipped_at", default: -> { "CURRENT_TIMESTAMP" }
    t.string "code", primary_key: true
    t.index ["status"], name: "index_orders_on_status"
    t.check_constraint "quantity > 0", name: "positive"
  end`),
    );
    expect(read.orders?.slice(1)).toEqual([
      { name: "status", type: "string", nullable: false, default: true },
      { name: "quantity", type: "smallint", nullable: false, default: false },
      { name: "total_cents", type: "bigint", nullable: true, default: false },
      {
        name: "flags",
        type: "integer limit 1",
        nullable: true,
        default: false,
      },
      { name: "priority", type: "integer", nullable: false, default: false },
      { name: "tags", type: "string[]", nullable: false, default: true },
      { name: "notes", type: "text", nullable: true, default: false },
      { name: "shipped_at", type: "datetime", nullable: true, default: true },
      {
        name: "code",
        type: "string",
        nullable: false,
        primary: true,
        default: false,
      },
    ]);
  });

  it("reads an older dump written with hash rockets", async () => {
    const read = await tables(`
ActiveRecord::Schema.define(:version => 20140101000000) do
  create_table "users", :force => true do |t|
    t.string "email", :null => false, :default => ""
  end
end
`);
    expect(read.users?.[1]).toEqual({
      name: "email",
      type: "string",
      nullable: false,
      default: true,
    });
  });

  it("reads t.column and t.primary_key by their arguments", async () => {
    const read = await tables(
      schema(`
  create_table "tokens", id: false do |t|
    t.primary_key "token", :uuid, default: -> { "gen_random_uuid()" }
    t.column "scope", :string, null: false
  end`),
    );
    expect(read.tokens).toEqual([
      {
        name: "token",
        type: "uuid",
        nullable: false,
        primary: true,
        default: true,
      },
      { name: "scope", type: "string", nullable: false, default: false },
    ]);
  });

  it("gives t.timestamps two NOT NULL columns with no default", async () => {
    const read = await tables(
      schema(`
  create_table "a" do |t|
    t.timestamps
  end
  create_table "b" do |t|
    t.timestamps null: true
  end`),
    );
    expect(read.a?.slice(1)).toEqual([
      { name: "created_at", type: "datetime", nullable: false, default: false },
      { name: "updated_at", type: "datetime", nullable: false, default: false },
    ]);
    expect(read.b?.slice(1).map((column) => column.nullable)).toEqual([
      true,
      true,
    ]);
  });

  it("marks a generated column derived", async () => {
    const read = await tables(
      schema(`
  create_table "people" do |t|
    t.string "name"
    t.virtual "slug", type: :string, as: "lower(name)", stored: true
  end`),
    );
    expect(read.people?.[2]).toEqual({
      name: "slug",
      type: "string",
      nullable: true,
      default: true,
      derived: true,
    });
  });
});

describe("references and foreign keys", () => {
  it("reads t.references with its type, polymorphic: and foreign_key:", async () => {
    const read = await tables(
      schema(`
  create_table "comments" do |t|
    t.references "post", null: false, foreign_key: true
    t.belongs_to "author", type: :uuid, foreign_key: { to_table: :users }
    t.references "commentable", polymorphic: true, null: false
    t.references "ghost", foreign_key: true
  end
  create_table "posts" do |t|
  end`),
    );
    expect(read.comments?.slice(1)).toEqual([
      {
        name: "post_id",
        type: "bigint",
        nullable: false,
        default: false,
        foreignKey: "posts",
      },
      {
        name: "author_id",
        type: "uuid",
        nullable: true,
        default: false,
        foreignKey: "users",
      },
      {
        name: "commentable_id",
        type: "bigint",
        nullable: false,
        default: false,
      },
      {
        name: "commentable_type",
        type: "string",
        nullable: false,
        default: false,
      },
      { name: "ghost_id", type: "bigint", nullable: true, default: false },
    ]);
  });

  it("reads add_foreign_key on the column it names, or on the singular of the table it points at", async () => {
    const read = await tables(
      schema(`
  create_table "orders" do |t|
    t.bigint "customer_id"
    t.bigint "address_id"
  end
  add_foreign_key "orders", "users", column: "customer_id"
  add_foreign_key "orders", "addresses"
  add_foreign_key "missing", "users"`),
    );
    expect(
      read.orders?.map((column) => [column.name, column.foreignKey]),
    ).toEqual([
      ["id", undefined],
      ["customer_id", "users"],
      ["address_id", "addresses"],
    ]);
  });
});

describe("the summaries", () => {
  it("are one storage provider per table, marked as a dump", async () => {
    const [summary] = await railsSchemaToSummaries(
      schema(
        `  create_table "audit.events" do |t|\n    t.string "kind"\n  end`,
      ),
      { source: "db/schema.rb", scope: "billing", storageSystem: "postgresql" },
    );
    expect(summary?.location).toEqual({
      file: "db/schema.rb",
      range: { start: 2, end: 4 },
      exportName: null,
    });
    expect(summary?.identity.boundaryBinding).toEqual({
      transport: "postgresql",
      semantics: {
        name: "storage",
        storageSystem: "postgresql",
        scope: "billing",
        container: "audit.events",
        accessPath: null,
      },
      recognition: "rails-schema",
    });
    expect(summary?.metadata?.storageContract).toMatchObject({
      fieldSet: "exhaustive",
      origin: "dump",
    });
  });

  it("leave the engine unset when nothing says which", async () => {
    const [summary] = await railsSchemaToSummaries(
      schema(`  create_table "users" do |t|\n  end`),
    );
    const semantics = summary?.identity.boundaryBinding?.semantics;
    expect(semantics).toMatchObject({ storageSystem: null, scope: "default" });
  });

  it("skip a table whose name is not written out", async () => {
    expect(
      await railsSchemaToSummaries(
        schema("  create_table TABLE_NAME do |t|\n  end"),
      ),
    ).toEqual([]);
  });
});

describe("db/structure.sql", () => {
  const dump = `
CREATE TABLE public.users (
    id bigint NOT NULL,
    slug text GENERATED ALWAYS AS (lower(name)) STORED
);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the same contract shape, and says what the grammar could not read", () => {
    const warnings: string[] = [];
    const [users] = structureSqlToSummaries(dump, { warnings });

    expect(fieldsOf(users)).toEqual([
      {
        name: "id",
        type: "bigint",
        nullable: false,
        default: false,
        primary: true,
      },
      { name: "slug", type: "text" },
    ]);
    expect(users?.metadata?.storageContract).toMatchObject({
      origin: "dump",
    });
    expect(warnings).toEqual([
      "db/structure.sql: the SQL grammar could not read 1 part of the 2 table statements, so what it says is left unchecked: line 4 (users.slug).",
    ]);
  });

  it("writes what it could not read to stderr when nothing collects it", () => {
    const written = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    structureSqlToSummaries(dump);
    expect(written).toHaveBeenCalledWith(
      expect.stringContaining("[suss] rails-schema: db/structure.sql:"),
    );
  });

  it("reads a MySQL dump when the app's database is MySQL", () => {
    const [orders] = structureSqlToSummaries(
      "CREATE TABLE `orders` (`id` bigint NOT NULL AUTO_INCREMENT, `paid` tinyint(1) NOT NULL DEFAULT '0', PRIMARY KEY (`id`));",
      { storageSystem: "mysql" },
    );
    expect(fieldsOf(orders).map((field) => field.type)).toEqual([
      "bigint",
      "tinyint(1)",
    ]);
  });
});

describe("railsSchemaFileToSummaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-schema-"));

  it("reads a .sql file as db/structure.sql and anything else as db/schema.rb", async () => {
    const rb = path.join(dir, "schema.rb");
    const sql = path.join(dir, "structure.sql");
    fs.writeFileSync(rb, schema(`  create_table "users" do |t|\n  end`));
    fs.writeFileSync(sql, "CREATE TABLE public.users (id bigint NOT NULL);");

    const fromRb = await railsSchemaFileToSummaries(rb, { source: "a" });
    const fromSql = await railsSchemaFileToSummaries(sql, { source: "b" });
    expect(fromRb.map((summary) => summary.location.file)).toEqual(["a"]);
    expect(fieldsOf(fromSql[0])).toEqual([
      { name: "id", type: "bigint", nullable: false, default: false },
    ]);
  });

  it("labels each summary with the file's path from the project root", async () => {
    const rb = path.join(dir, "schema.rb");
    const [summary] = await railsSchemaFileToSummaries(rb, {
      projectRoot: path.dirname(dir),
    });
    expect(summary?.location.file).toBe(`${path.basename(dir)}/schema.rb`);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      railsSchemaFileToSummaries(path.join(dir, "missing.rb")),
    ).rejects.toThrow("Rails schema not found");
  });
});
