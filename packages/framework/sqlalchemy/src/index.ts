// @suss/framework-sqlalchemy: which calls a Python body makes against the
// database, for a project using SQLAlchemy. The adapter matches a call chain
// on what the method behind it says it returns, and the README says why.

import type { PythonPack, StoragePattern } from "@suss/adapter-python";

export interface SqlalchemyPackOptions {
  /**
   * Which database is behind the connection. SQLAlchemy talks to all of
   * them and the URL says which, so this is the project's own choice
   * rather than something the library settles.
   */
  storageSystem: "postgres" | "mysql" | "sqlite";
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
  };
}

export function sqlalchemyFramework(
  options: SqlalchemyPackOptions,
): PythonPack {
  return {
    name: "sqlalchemy",
    protocol: options.storageSystem,
    discovery: [],
    storage: sqlalchemyStorage(options),
  };
}
