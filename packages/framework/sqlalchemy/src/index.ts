// @suss/framework-sqlalchemy: which calls a Python body makes against the
// database, for a project using SQLAlchemy. The adapter matches a call chain
// on what the method behind it says it returns, and the README says why.

import type {
  PythonPack,
  RawSqlPattern,
  StoragePattern,
} from "@suss/adapter-python";

export interface SqlalchemyPackOptions {
  /**
   * Which database is behind the connection. SQLAlchemy talks to all of
   * them and the URL says which, so this is the project's own choice
   * rather than something the library settles.
   */
  storageSystem: "postgresql" | "mysql" | "sqlite";
}

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
      writes: ["update", "delete", "add", "add_all", "merge", "commit"],
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
      storageSystem: options.storageSystem,
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
    rawSql: sqlalchemyRawSql(options),
  };
}

export default sqlalchemyFramework;
