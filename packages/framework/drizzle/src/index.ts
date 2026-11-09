/**
 * Recognizes Drizzle ORM query-builder calls and raw `db.execute`
 * statements, and records each one as a storage access on the SQL table
 * it touches.
 *
 * Every path is a `@suss/recognize` declaration. A builder chain is read
 * at the call whose argument is the table: `.from(t)` for a select, the
 * operation itself for an insert, an update or a delete, and the query
 * method on the relational query API. The rest of the chain is read
 * from the calls made on that one's result. The README lists how the
 * receiver and the table name are settled, and what is left out.
 */

import { z } from "zod";

import { scopeOption, storageSystemOption } from "@suss/extractor";
import {
  anyOf,
  constructedFrom,
  declaredBy,
  pack,
  sqlStatements,
  storageCalls,
  typed,
} from "@suss/recognize";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  FieldsReadPick,
  OneArgument,
  SqlStatements,
  StorageCalls,
  StorageCallsSpec,
  StorageMethod,
} from "@suss/recognize";

/**
 * The options a `-f drizzle=config.json` file may set. The CLI checks
 * the file against this schema before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * The storage system the calls target, `"postgresql"` when unset. It
     * has to match the `storageSystem` on provider summaries, or the
     * calls do not pair.
     */
    storageSystem: storageSystemOption.optional(),
    /** Scope for the storage binding, `"default"` when unset. */
    scope: scopeOption.optional(),
  })
  .strict();

export type DrizzleRecognizerOptions = z.infer<typeof optionsSchema>;

/**
 * A database by the type Drizzle declares for it, so `drizzle(pool)`
 * from any driver, a wrapped `ctx.db` and a transaction's `tx` all count
 * whatever they are called. A project read without its dependencies
 * installed has no types, so a database made by `drizzle(...)` counts
 * as well.
 */
const DRIZZLE = anyOf(
  typed({ from: ["drizzle-orm"] }),
  constructedFrom({ from: ["drizzle-orm"], named: ["drizzle"] }),
);

/** A table, as the factory call a schema declares it with. */
const TABLE = constructedFrom({
  from: ["drizzle-orm"],
  named: ["pgTable", "mysqlTable", "sqliteTable"],
});

/**
 * The factory call the table argument was written as. An argument that
 * leads to no factory call gives no table, since its own spelling would
 * pair with a schema table that shares it (#121).
 */
const TABLE_CALL: CallStep = { to: "argument", at: 0, origin: TABLE };

/** The table's SQL name, the first argument of its factory call. */
const TABLE_AT: ArgumentPick = { of: [TABLE_CALL], at: 0 };

const WHERE: OneArgument = { of: [{ to: "chained", method: "where" }], at: 0 };

/** The columns the `where` condition reads off the call's table argument. */
const COLUMNS: FieldsReadPick = { fieldsRead: WHERE, off: { at: 0 } };

/** What a call that lists no columns reads or writes. */
const WHOLE_ROW = ["*"];

/** What every builder chain says about the store. */
function builder(
  options: DrizzleRecognizerOptions,
  more: Pick<StorageCallsSpec, "clientAt"> = {},
): StorageCalls {
  return storageCalls({
    system: options.storageSystem ?? "postgresql",
    scope: options.scope ?? "default",
    client: DRIZZLE,
    unsettledName: "nothing",
    ...more,
  });
}

/** `.from(t)` on the select call the chain is about. */
const FROM: CallStep = { to: "chained", method: "from" };

const SELECT: StorageMethod = {
  kind: "read",
  fields: { keysOf: { at: 0 }, otherwise: WHOLE_ROW },
  selector: { fieldsRead: WHERE, off: { of: [FROM], at: 0 } },
};

/**
 * Every select chain has one `.from(t)`, and it has the table, so a
 * select is read there. The chain is about the select call it is made
 * on, which says the operation and is made on the database.
 */
function selects(options: DrizzleRecognizerOptions): StorageCalls {
  return builder(options)
    .about({ to: "receiver" }, { calledAs: ["from"] })
    .methods({ select: SELECT, selectDistinct: SELECT })
    .container({ of: [FROM, TABLE_CALL], at: 0 })
    .slots("none")
    .example("db.select({ id: users.id }).from(users).where(eq(users.id, id))");
}

function mutations(options: DrizzleRecognizerOptions): StorageCalls {
  return builder(options)
    .methods({
      insert: {
        kind: "write",
        fields: {
          keysOf: { of: [{ to: "chained", method: "values" }], at: 0 },
          otherwise: WHOLE_ROW,
        },
      },
      update: {
        kind: "write",
        fields: {
          keysOf: { of: [{ to: "chained", method: "set" }], at: 0 },
          otherwise: WHOLE_ROW,
        },
        selector: COLUMNS,
      },
      delete: { kind: "write", fields: WHOLE_ROW, selector: COLUMNS },
    })
    .container(TABLE_AT)
    .slots("none")
    .example("db.update(users).set({ name }).where(eq(users.id, id))");
}

/** `columns` narrows the fields read and `with` adds relations, so both count. */
const QUERY: StorageMethod = {
  kind: "read",
  fields: {
    keysOf: { at: 0 },
    under: ["columns", "with"],
    otherwise: WHOLE_ROW,
  },
};

/**
 * In `db.query.users.findMany()` Drizzle types `users` as a key of the
 * schema the database was made with, so the receiver is the schema
 * export and the table is the factory call behind it. The key is the
 * export's name, which need not be the SQL name, so it is never used in
 * its place.
 */
function queries(options: DrizzleRecognizerOptions): StorageCalls {
  return builder(options, {
    clientAt: [{ to: "member" }, { to: "member", named: "query" }],
  })
    .methods({ findMany: QUERY, findFirst: QUERY })
    .container({ of: [{ to: "receiver", origin: TABLE }], at: 0 })
    .slots("none")
    .example(
      "db.query.users.findMany({ columns: { id: true }, with: { orders: true } })",
    );
}

/**
 * Only `execute` counts. The SQLite driver's `run`, `all` and `get` also
 * take a statement, but a map's `get` in a Drizzle file would then be
 * read as a query.
 */
function rawStatements(options: DrizzleRecognizerOptions): SqlStatements {
  const storageSystem = options.storageSystem ?? "postgresql";
  return sqlStatements({
    system: storageSystem,
    dialect: storageSystem,
    scope: options.scope ?? "default",
    client: declaredBy("drizzle-orm"),
  })
    .methods({ execute: { statement: { at: 0 } } })
    .interpolating({ from: constructedFrom("drizzle-orm"), named: { at: 0 } })
    .example("db.execute(sql`SELECT id, email FROM users`)");
}

/**
 * The pack discovers no units, so its effects need a handler pack such
 * as Express to attach to.
 */
export function drizzleFramework(
  options: DrizzleRecognizerOptions = {},
): PatternPack {
  return pack(
    "drizzle",
    [
      selects(options),
      mutations(options),
      queries(options),
      rawStatements(options),
    ],
    {
      languages: ["typescript", "javascript"],
      recognizedAs: "@suss/framework-drizzle",
      version: "2",
      protocol: "in-process",
    },
  );
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-drizzle",
  dependencies: [{ ecosystem: "npm", name: "drizzle-orm" }],
  reads:
    "Drizzle ORM query-builder and relational-query calls. Each one becomes a storage-access interaction on the SQL table it touches.",
};

export default drizzleFramework;
