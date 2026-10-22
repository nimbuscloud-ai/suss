# @suss/contract-rails-schema

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from the dump a Rails app keeps of its database, `db/schema.rb` or `db/structure.sql`. Rails writes the dump out of the database itself after every migration, so when another part of the project declares the same tables again, such as a Prisma or Drizzle copy in a TypeScript service, suss takes the dump as what the database contains and reports every column where the copy disagrees with it.

## What this package reads

`db/schema.rb` is Ruby, and the Ruby adapter's parser reads it, so nothing in it runs. A table is what one `create_table` call says:

- the options on `create_table`: no `id:` gives a `bigint` key named `id` that draws on a sequence, `id: :uuid` or `id: { type: :string }` gives the key that type, `primary_key: "code"` renames it, `id: false` leaves it out, and `primary_key: ["a", "b"]` makes a composite key of columns the block declares. A key of a non-integer type has a default only when `default:` gives one, and `default: nil` means none.
- each `t.<type> "name"` call, with `null:`, `default:`, `array: true` and `limit:`. `t.integer limit: 2` becomes `smallint` and `limit: 8` becomes `bigint`, since the type families have no spelling for an integer with a limit. `t.column "name", :type` and `t.primary_key` are read by their arguments, and older dumps written `:null => false` read the same.
- `t.references "order"`, as the column `order_id`, a `bigint` unless `type:` says otherwise. `polymorphic: true` adds `order_type`, and `foreign_key: true` points it at the declared table whose name is the plural of `order`, or at the table `to_table:` gives.
- `t.timestamps`, as `created_at` and `updated_at`, NOT NULL unless `null: true`, with no default.
- `t.virtual`, as a column marked `derived`, since the database computes it and no insert writes it.
- `add_foreign_key "orders", "users"`, on the column `column:` gives, or on `user_id`.

`db/structure.sql` is read through `readSqlSchema` in [`@suss/sql`](../../sql), which parses `CREATE TABLE` and the `ALTER TABLE` statements that add keys and serial defaults. The grammar does not know every type a dump uses, and it reads such a column with the type set aside. Whatever it still cannot read is left unstated, and one line says how much was left out. `suss contract` prints that line on stderr. The dump is read as MySQL when the app's database is MySQL, and as Postgres otherwise.

## What it produces

One `library`-kind summary per table, with a storage boundary binding: `recognition: "rails-schema"`, the storage system, a scope, and the table as the container. A table outside the default schema keeps its schema, as `audit.events`. The engine comes from `config/database.yml`, which `suss contract --from rails-schema` reads through the ActiveRecord pack. Called from code, it is the `storageSystem` option, and a summary with none meets a declaration on any engine.

The behavior is in `metadata.storageContract`:

- `fieldSet: "exhaustive"`, since the dump lists every column the table has.
- `fields`, one entry per column, each with `name`, `type` as Rails or SQL spells it, `nullable`, `default`, and `primary` and `foreignKey` where they apply. Every column states `default`: `true` when the database fills the column, as an implicit key or a `default:` does, and `false` when nothing does.
- `origin: "dump"`, which tells the checker this declaration speaks for the database.

A dump is compared only with other declarations of its tables. It is never paired with the queries in code. A Ruby write records every keyword key of `create` and `update`, including attributes a model defines in code, such as `password` and `*_attributes`, and against a dump each of those would look like a column the table lacks.

## What it does not read

- **Indexes, check constraints, comments and views.** `t.index` and `t.check_constraint` are skipped.
- **Enum values, lengths, precisions and scales.** `t.enum` has the type `enum`, and `t.string limit: 255` the type `string`.
- **A dump written by Rails 5.0 or earlier**, whose implicit key was a four-byte integer. The reader takes every implicit key as a `bigint`, which is what Rails has written since 5.1.
- **Which database of a multi-database app a dump belongs to.** `db/cache_schema.rb` reads like any other dump, in the scope `"default"` unless the `scope` option gives another, and `suss init` lists only `db/schema.rb` and `db/structure.sql`.

## Worked example

```ruby
create_table "attachments", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
  t.uuid "blob_id", null: false
  t.references "order", null: false, foreign_key: true
end
```

```sh
suss contract --from rails-schema db/schema.rb -o .suss/db.json
suss contract --from prisma prisma/schema.prisma -o .suss/prisma.json
suss check --dir .suss
```

The `attachments` summary declares `id` (a `uuid` key with a default), `blob_id` and `order_id` (NOT NULL, with no default), and a foreign key from `order_id` to `orders`. A Prisma model mapped to `attachments` that declares `blobId BigInt @map("blob_id")` gets an error that the database contains a uuid there.

Or from code:

```ts
import { railsSchemaFileToSummaries } from "@suss/contract-rails-schema";

const summaries = await railsSchemaFileToSummaries("db/schema.rb", {
  storageSystem: "postgresql",
});
```

## Where it fits in suss

The package depends on `@suss/behavioral-ir` for the IR types it produces, `@suss/adapter-ruby` for its parser, and `@suss/sql` for its SQL grammar. The checker's `checkSchemaAgreement` compares its summaries with the ones `@suss/contract-prisma` and other declarations write.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-rails-schema.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md). For how contract sources fit together, see [`docs/packs/contract-sources.md`](../../../docs/packs/contract-sources.md).
