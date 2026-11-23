/**
 * The calls a Python body makes against the database through SQLModel.
 * The README explains why SQLModel needs a pack of its own on top of the
 * sqlalchemy one.
 */

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";
import {
  PACK_VERSION,
  queryChains,
  rawStatements,
  SESSION_WRITES,
  SQLALCHEMY_MODEL_CALLS,
  SESSION_RECORDS_NOTHING as SQLALCHEMY_RECORDS_NOTHING,
  SQLALCHEMY_TYPES,
  sqlalchemyClassBodies,
  statementChains,
  storageWords,
  withStatements,
} from "@suss/framework-sqlalchemy";
import { classBody, imported } from "@suss/recognize";

import type { PythonPack } from "@suss/adapter-python";
import type { ClassBodyDeclaration } from "@suss/extractor";
import type { ModelCalls, QueryTypes } from "@suss/framework-sqlalchemy";
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

/** `exec` is SQLModel's name for `execute`, and records nothing either. */
const SESSION_RECORDS_NOTHING = ["exec", ...SQLALCHEMY_RECORDS_NOTHING];

/** SQLModel's session types and statements, then SQLAlchemy's. */
export const SQLMODEL_TYPES: readonly QueryTypes[] = [
  {
    module: "sqlmodel",
    types: ["Session"],
    writes: SESSION_WRITES,
    recordsNothing: SESSION_RECORDS_NOTHING,
  },
  {
    module: "sqlmodel.ext.asyncio.session",
    types: ["AsyncSession"],
    writes: SESSION_WRITES,
    recordsNothing: SESSION_RECORDS_NOTHING,
  },
  {
    module: "sqlmodel",
    types: ["Select", "SelectOfScalar", "Update", "Delete", "Insert"],
    writes: ["update", "delete", "insert", "commit"],
    values: ["values"],
  },
  ...SQLALCHEMY_TYPES,
];

/**
 * SQLModel builds a statement with a function the file imports from the
 * package root, `select(Item).where(...)`, and a SQLModel project still
 * imports from `sqlalchemy` for anything SQLModel does not re-export.
 */
export const STATEMENT_MODULES = ["sqlmodel", "sqlalchemy"];

/**
 * SQLAlchemy's model rules with SQLModel's additions: a model inherits
 * from `SQLModel` (`class User(SQLModel, table=True)`), and `exec` runs
 * a statement.
 */
export const SQLMODEL_MODEL_CALLS: ModelCalls = {
  baseNames: [...SQLALCHEMY_MODEL_CALLS.baseNames, "SQLModel"],
  givesBack: SQLALCHEMY_MODEL_CALLS.givesBack,
  entryMethods: [
    ...SQLALCHEMY_MODEL_CALLS.entryMethods,
    { method: "exec", argument: 0 },
  ],
  entryFunctions: [
    ...SQLALCHEMY_MODEL_CALLS.entryFunctions,
    { module: "sqlmodel", name: "select", argument: 0 },
  ],
};

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
 * Adds the storage chains to the route pack a run already uses, since a
 * project picks its web framework and its database library separately.
 */
export function withSqlmodel(
  pack: PythonPack,
  options: SqlmodelPackOptions,
): PythonPack {
  return withStatements(pack, [
    ...sqlmodelRawStatements(options),
    queryChains("sqlmodel-queries", SQLMODEL_TYPES, options, {
      words: storageWords(SQLMODEL_MODEL_CALLS),
      classBodies: sqlmodelClassBodies(),
    }),
    statementChains("sqlmodel-statements", STATEMENT_MODULES, options),
  ]);
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
    {
      name: "sqlmodel",
      version: PACK_VERSION,
      protocol: options.storageSystem,
      discovery: [],
    },
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
    databaseOption: "storageSystem",
  },
};

export default sqlmodelFramework;
