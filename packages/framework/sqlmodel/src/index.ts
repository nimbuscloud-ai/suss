/**
 * The calls a Python body makes against the database through SQLModel.
 * The README explains why SQLModel needs a pack of its own on top of the
 * sqlalchemy one.
 */

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";
import {
  rawStatements,
  sqlalchemyClassBodies,
  sqlalchemyModels,
  sqlalchemyStorage,
  withStatements,
} from "@suss/framework-sqlalchemy";
import { classBody, imported } from "@suss/recognize";

import type {
  PyModelQueries,
  PythonPack,
  StoragePattern,
} from "@suss/adapter-python";
import type { ClassBodyDeclaration } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { PatternPack } from "@suss/recognize";

/**
 * The CLI checks a `-f sqlmodel=config.json` file against this schema
 * before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * Which database is behind the engine. SQLModel works with several,
     * and the connection URL picks one, so the project has to set this.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type SqlmodelPackOptions = z.infer<typeof optionsSchema>;

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
 * `exec`, `execute` and the scalar calls run a statement whose own chain
 * is read already, and the rest only manage the session. `exec` is
 * SQLModel's name for `execute`.
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
 * SQLModel's query types and write methods under the modules SQLModel
 * exports them from, followed by SQLAlchemy's. A SQLModel project still
 * imports from `sqlalchemy` for anything SQLModel does not re-export.
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
      // `select(Item).where(...)` calls a constructor imported from the
      // package root, so there is no project method in the chain whose
      // return type the adapter could read.
      queryFunctions: ["select", "insert", "update", "delete"],
      valueMethods: ["values"],
      storageSystem: options.storageSystem,
    },
    ...sqlalchemyStorage(options),
  ];
}

/**
 * SQLAlchemy's model rules with SQLModel's additions: a model inherits
 * from `SQLModel` (`class User(SQLModel, table=True)`), and `exec` runs
 * a statement.
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
  }));
}

/** SQLAlchemy's `relationship` field, and SQLModel's own `Relationship`. */
export function sqlmodelClassBodies(): ClassBodyDeclaration[] {
  return [
    ...sqlalchemyClassBodies(),
    classBody({
      fields: {
        association: {
          madeBy: imported({ from: ["sqlmodel"], named: ["Relationship"] }),
        },
      },
    }),
  ];
}

/** SQLModel re-exports `text`, so a project may import it from either package. */
export function sqlmodelRawStatements(
  options: SqlmodelPackOptions,
): PatternPack[] {
  return [
    rawStatements("sqlmodel", options),
    rawStatements("sqlalchemy", options),
  ];
}

/**
 * Adds the storage patterns to the route pack a run already uses. A
 * project picks its web framework and its database library separately,
 * so the two packs combine.
 */
export function withSqlmodel(
  pack: PythonPack,
  options: SqlmodelPackOptions,
): PythonPack {
  return withStatements(
    {
      ...pack,
      storage: [...(pack.storage ?? []), ...sqlmodelStorage(options)],
      models: [...(pack.models ?? []), ...sqlmodelModels()],
      classBodies: [...(pack.classBodies ?? []), ...sqlmodelClassBodies()],
    },
    sqlmodelRawStatements(options),
  );
}

export function sqlmodelFramework(options: SqlmodelPackOptions): PythonPack {
  // A bare `-f sqlmodel` skips the CLI's schema check, so the options
  // can arrive here without `storageSystem`.
  if (typeof options?.storageSystem !== "string") {
    throw new Error(
      "it needs `storageSystem`, which database is behind the engine: postgresql, mysql, or sqlite. SQLModel talks to all of them and the connection URL settles which, so the pack cannot.",
    );
  }
  return withSqlmodel(
    { name: "sqlmodel", protocol: options.storageSystem, discovery: [] },
    options,
  );
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-sqlmodel",
  dependencies: [{ ecosystem: "pypi", name: "sqlmodel" }],
  reads:
    "SQLModel calls (Python). The pack declares which types a query returns and which methods write, under the modules SQLModel exports them from. It also includes the SQLAlchemy patterns, since a SQLModel project reaches those too.",
  configuration: {
    file: "suss.sqlmodel.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the engine: postgresql, mysql, or sqlite. SQLModel talks to all of them and the connection URL settles which, so the pack cannot.",
  },
};

export default sqlmodelFramework;
