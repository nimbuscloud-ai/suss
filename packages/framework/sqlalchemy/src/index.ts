// @suss/framework-sqlalchemy: which calls a Python body makes against the
// database, for a project using SQLAlchemy. The adapter matches a call chain
// on what the method behind it says it returns, and the README says why.

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
 * What `-f sqlalchemy=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * Which database is behind the connection. SQLAlchemy talks to all of
     * them and the URL says which, so this is the project's own choice
     * rather than something the library settles.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type SqlalchemyPackOptions = z.infer<typeof optionsSchema>;

/**
 * The types SQLAlchemy hands back from a query, and the methods that change
 * what is stored rather than read it. Everything here is SQLAlchemy's own. A
 * project base class that wraps it is matched by resolving through it, so
 * nothing about any project belongs in this list.
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
      // A Session runs a statement built by `select`/`update`/... whose
      // own chain is read, and the rest of these manage the session.
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
      // 2.0 style writes `select(User.id).where(...)`, importing the
      // constructor rather than reaching it through a mapped class, so there
      // is no project method in between whose return says what it is.
      queryFunctions: ["select", "insert", "update", "delete"],
      valueMethods: ["values"],
      storageSystem: options.storageSystem,
    },
  ];
}

/** The names a mapped class's ancestry arrives at, across the ways SQLAlchemy lets a project declare a base. */
const MODEL_BASE_NAMES = [
  "DeclarativeBase",
  "declarative_base",
  "DeclarativeBaseNoMeta",
];

/** Methods that hand back a query over the same model, which a later read narrows to one row. */
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

/** Methods that run the query and hand back rows of the model. */
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

/** Session methods that take the mapped class itself and give back one of it. */
const SESSION_ENTRY_METHODS = [
  { method: "get", argument: 0 },
  { method: "query", argument: 0 },
  { method: "execute", argument: 0 },
];

/**
 * What SQLAlchemy gives back when a call is passed a mapped class, so a
 * method read off the result runs the one the project's model declares.
 * `session.execute(stmt)` takes a statement rather than the class, and
 * the statement has already settled on one, which is the same argument
 * as far as the rules are concerned.
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
 * The function SQLAlchemy gives a project for handing the database a
 * statement it wrote itself. `text` is the one, and it comes from the
 * package root.
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
 * Add the storage patterns to the route pack a run already uses. A web
 * framework and a database library are separate libraries and a project picks
 * both, so this composes rather than replacing anything.
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
  // The CLI passes on a config somebody wrote by hand, with nothing
  // typed in front of it, so it can arrive here unset.
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

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-sqlalchemy",
  dependencies: [{ ecosystem: "pypi", name: "sqlalchemy" }],
  reads: `SQLAlchemy calls (Python): says which types a query comes back as and which methods write, and the adapter matches a call chain by resolving through a project's own base class to what the method behind it says it returns.`,
  configuration: {
    file: "suss.sqlalchemy.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the engine: postgresql, mysql, or sqlite. SQLAlchemy talks to all of them and the connection URL settles which, so the pack cannot.",
  },
};

export default sqlalchemyFramework;
