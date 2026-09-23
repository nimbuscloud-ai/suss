/**
 * The calls a Python body makes against the database through SQLAlchemy.
 * The adapter matches a call chain by the declared return type of the
 * method behind it, and the README explains why.
 */

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";

import type {
  PyModelQueries,
  PythonPack,
  RawSqlPattern,
  StoragePattern,
} from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * The CLI checks a `-f sqlalchemy=config.json` file against this schema
 * before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * Which database is behind the engine. SQLAlchemy works with several,
     * and the connection URL picks one, so the project has to set this.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type SqlalchemyPackOptions = z.infer<typeof optionsSchema>;

/**
 * SQLAlchemy's query types and the methods that write. The list has only
 * SQLAlchemy's own names, because the adapter follows a project's base
 * class through to these types.
 */
export function sqlalchemyStorage(
  options: SqlalchemyPackOptions,
): StoragePattern[] {
  return [
    {
      module: "sqlalchemy.orm",
      queryTypes: ["Query", "Session"],
      writes: [
        "update",
        "delete",
        "add",
        "add_all",
        "merge",
        "flush",
        "commit",
        "bulk_save_objects",
        "bulk_insert_mappings",
        "bulk_update_mappings",
      ],
      // `execute` and the scalar calls run a statement whose own chain is
      // read already, and the rest only manage the session.
      recordsNothing: [
        "execute",
        "scalars",
        "scalar",
        "begin",
        "rollback",
        "close",
        "expire",
        "expire_all",
        "expunge",
        "expunge_all",
      ],
      storageSystem: options.storageSystem,
    },
    {
      module: "sqlalchemy",
      queryTypes: ["Select", "Update", "Delete", "Insert"],
      writes: ["update", "delete", "insert", "commit"],
      // A 2.0 statement such as `select(User.id).where(...)` calls an
      // imported constructor directly, so there is no project method in
      // the chain whose return type the adapter could read.
      queryFunctions: ["select", "insert", "update", "delete"],
      valueMethods: ["values"],
      storageSystem: options.storageSystem,
    },
  ];
}

/** SQLAlchemy has several ways to declare a base, and every mapped class inherits from one of these. */
const MODEL_BASE_NAMES = [
  "DeclarativeBase",
  "declarative_base",
  "DeclarativeBaseNoMeta",
];

/** These return a query over the same model, so the chain stays on that model. */
const NARROWS_A_QUERY = [
  "filter",
  "filter_by",
  "where",
  "order_by",
  "limit",
  "offset",
  "options",
  "join",
  "outerjoin",
  "distinct",
  "group_by",
  "having",
];

const RUNS_A_QUERY = [
  "first",
  "one",
  "one_or_none",
  "scalar",
  "scalar_one",
  "scalar_one_or_none",
  "scalars",
  "get",
  "all",
];

/** Session methods whose first argument settles which model the result is. */
const SESSION_ENTRY_METHODS = [
  { method: "get", argument: 0 },
  { method: "query", argument: 0 },
  { method: "execute", argument: 0 },
];

/**
 * The calls that give back the mapped class they were passed, so a method
 * called on the result resolves to the one the project's model declares.
 * `session.execute(stmt)` takes a statement instead of the class, but the
 * statement has already settled on one model, so the rules treat the two
 * the same way.
 */
export function sqlalchemyModels(): PyModelQueries[] {
  return [
    {
      baseNames: MODEL_BASE_NAMES,
      givesBack: [...NARROWS_A_QUERY, ...RUNS_A_QUERY],
      entryMethods: SESSION_ENTRY_METHODS,
      entryFunctions: [{ module: "sqlalchemy", name: "select", argument: 0 }],
      relationships: [{ module: "sqlalchemy.orm", name: "relationship" }],
    },
  ];
}

/**
 * `text`, imported from the package root, is how a project hands
 * SQLAlchemy a statement it wrote itself.
 */
export function sqlalchemyRawSql(
  options: SqlalchemyPackOptions,
): RawSqlPattern[] {
  return [
    {
      module: "sqlalchemy",
      functions: ["text"],
      storageSystem: options.storageSystem,
    },
  ];
}

/**
 * Adds the storage patterns to the route pack a run already uses. A
 * project picks its web framework and its database library separately,
 * so the two packs combine.
 */
export function withSqlalchemy(
  pack: PythonPack,
  options: SqlalchemyPackOptions,
): PythonPack {
  return {
    ...pack,
    storage: [...(pack.storage ?? []), ...sqlalchemyStorage(options)],
    models: [...(pack.models ?? []), ...sqlalchemyModels()],
    rawSql: [...(pack.rawSql ?? []), ...sqlalchemyRawSql(options)],
  };
}

export function sqlalchemyFramework(
  options: SqlalchemyPackOptions,
): PythonPack {
  // A bare `-f sqlalchemy` skips the CLI's schema check, so the options
  // can arrive here without `storageSystem`.
  if (typeof options?.storageSystem !== "string") {
    throw new Error(
      "it needs `storageSystem`, which database is behind the engine: postgresql, mysql, or sqlite. SQLAlchemy talks to all of them and the connection URL settles which, so the pack cannot.",
    );
  }
  return {
    name: "sqlalchemy",
    protocol: options.storageSystem,
    discovery: [],
    storage: sqlalchemyStorage(options),
    models: sqlalchemyModels(),
    rawSql: sqlalchemyRawSql(options),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-sqlalchemy",
  dependencies: [{ ecosystem: "pypi", name: "sqlalchemy" }],
  reads: `SQLAlchemy calls (Python). The pack declares which types a query returns and which methods write. The adapter matches a call chain by following a project's own base class to the method behind the call, and reads that method's declared return type.`,
  configuration: {
    file: "suss.sqlalchemy.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the engine: postgresql, mysql, or sqlite. SQLAlchemy talks to all of them and the connection URL settles which, so the pack cannot.",
  },
};

export default sqlalchemyFramework;
