// @suss/framework-sqlmodel: which calls a Python body makes against the
// database, for a project using SQLModel. The README says why it is a pack
// of its own rather than a line in the sqlalchemy one.

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";
import {
  sqlalchemyModels,
  sqlalchemyRawSql,
  sqlalchemyStorage,
} from "@suss/framework-sqlalchemy";

import type {
  PyModelQueries,
  PythonPack,
  RawSqlPattern,
  StoragePattern,
} from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * What `-f sqlmodel=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * Which database is behind the engine. SQLModel talks to all of them
     * and the URL says which, so this is the project's own choice rather
     * than something the library settles.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type SqlmodelPackOptions = z.infer<typeof optionsSchema>;

/** The Session methods that change what is stored rather than read it. */
const SESSION_WRITES = [
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
];

/**
 * A Session runs a statement built by `select`/`update`/... whose own
 * chain is read, and the rest of these manage the session. `exec` is
 * SQLModel's own name for running a statement.
 */
const SESSION_RECORDS_NOTHING = [
  "exec",
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
];

/**
 * The types SQLModel hands back from a query and the methods that write,
 * under the modules SQLModel exports them from, followed by SQLAlchemy's
 * own. Everything here is the library's; nothing about any project
 * belongs in this list.
 */
export function sqlmodelStorage(
  options: SqlmodelPackOptions,
): StoragePattern[] {
  return [
    {
      module: "sqlmodel",
      queryTypes: ["Session"],
      writes: SESSION_WRITES,
      recordsNothing: SESSION_RECORDS_NOTHING,
      storageSystem: options.storageSystem,
    },
    {
      module: "sqlmodel.ext.asyncio.session",
      queryTypes: ["AsyncSession"],
      writes: SESSION_WRITES,
      recordsNothing: SESSION_RECORDS_NOTHING,
      storageSystem: options.storageSystem,
    },
    {
      module: "sqlmodel",
      queryTypes: ["Select", "SelectOfScalar", "Update", "Delete", "Insert"],
      writes: ["update", "delete", "insert", "commit"],
      // `select(Item).where(...)` imports the constructor from the package
      // root, so there is no project method in between whose return says
      // what it is.
      queryFunctions: ["select", "insert", "update", "delete"],
      valueMethods: ["values"],
      storageSystem: options.storageSystem,
    },
    ...sqlalchemyStorage(options),
  ];
}

/**
 * What SQLModel gives back when a call is passed one of a project's
 * model classes. A model is written `class User(SQLModel, table=True)`,
 * and `exec` is SQLModel's own name for running a statement, so both go
 * on top of what SQLAlchemy already declares.
 */
export function sqlmodelModels(): PyModelQueries[] {
  return sqlalchemyModels().map((model) => ({
    baseNames: [...model.baseNames, "SQLModel"],
    givesBack: model.givesBack,
    entryMethods: [...model.entryMethods, { method: "exec", argument: 0 }],
    entryFunctions: [
      ...model.entryFunctions,
      { module: "sqlmodel", name: "select", argument: 0 },
    ],
    relationships: [
      ...(model.relationships ?? []),
      { module: "sqlmodel", name: "Relationship" },
    ],
  }));
}

/** `text` for a statement the project wrote itself, from SQLModel's root and from SQLAlchemy's. */
export function sqlmodelRawSql(options: SqlmodelPackOptions): RawSqlPattern[] {
  return [
    {
      module: "sqlmodel",
      functions: ["text"],
      storageSystem: options.storageSystem,
    },
    ...sqlalchemyRawSql(options),
  ];
}

/**
 * Add the storage patterns to the route pack a run already uses. A web
 * framework and a database library are separate libraries and a project picks
 * both, so this composes rather than replacing anything.
 */
export function withSqlmodel(
  pack: PythonPack,
  options: SqlmodelPackOptions,
): PythonPack {
  return {
    ...pack,
    storage: [...(pack.storage ?? []), ...sqlmodelStorage(options)],
    models: [...(pack.models ?? []), ...sqlmodelModels()],
    rawSql: [...(pack.rawSql ?? []), ...sqlmodelRawSql(options)],
  };
}

export function sqlmodelFramework(options: SqlmodelPackOptions): PythonPack {
  // The CLI passes on a config somebody wrote by hand, with nothing
  // typed in front of it, so it can arrive here unset.
  if (typeof options?.storageSystem !== "string") {
    throw new Error(
      "it needs `storageSystem`, which database is behind the engine: postgresql, mysql, or sqlite. SQLModel talks to all of them and the connection URL settles which, so the pack cannot.",
    );
  }
  return {
    name: "sqlmodel",
    protocol: options.storageSystem,
    discovery: [],
    storage: sqlmodelStorage(options),
    models: sqlmodelModels(),
    rawSql: sqlmodelRawSql(options),
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-sqlmodel",
  dependencies: [{ ecosystem: "pypi", name: "sqlmodel" }],
  reads:
    "SQLModel calls (Python): says which types a query comes back as and which methods write, under the modules SQLModel exports them from, and includes the SQLAlchemy patterns a SQLModel project also reaches.",
  configuration: {
    file: "suss.sqlmodel.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the engine: postgresql, mysql, or sqlite. SQLModel talks to all of them and the connection URL settles which, so the pack cannot.",
  },
};

export default sqlmodelFramework;
