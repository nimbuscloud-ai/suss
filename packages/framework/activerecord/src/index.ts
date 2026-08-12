// @suss/framework-activerecord: which calls a Ruby body makes against the
// database, for a project on Rails. The adapter matches a call by what its
// receiver inherits, and the README says why ancestry.

import type { RbStoragePattern, RubyPack } from "@suss/adapter-ruby";

export interface ActiveRecordPackOptions {
  /**
   * Which database is behind the connection. ActiveRecord talks to all of
   * them and database.yml says which, so the project supplies this.
   */
  storageSystem: "postgres" | "mysql" | "sqlite";
}

/**
 * The base class the library gives a model, and the methods that change what
 * is stored rather than read it. Everything here is ActiveRecord's own. A
 * project's `ApplicationRecord` is matched by following what it extends, so
 * nothing about any project belongs in this list.
 */
export function activeRecordStorage(
  options: ActiveRecordPackOptions,
): RbStoragePattern[] {
  return [
    {
      baseClasses: ["ActiveRecord::Base"],
      writes: [
        "create",
        "create!",
        "insert",
        "insert_all",
        "update",
        "update!",
        "update_all",
        "upsert",
        "upsert_all",
        "save",
        "save!",
        "destroy",
        "destroy!",
        "destroy_all",
        "delete",
        "delete_all",
        "touch",
      ],
      storageSystem: options.storageSystem,
    },
  ];
}

/**
 * Add the storage patterns to whichever pack a run already uses. A GraphQL
 * schema and a database library are separate libraries and a project picks
 * both, so this composes rather than replacing anything.
 */
export function withActiveRecord(
  pack: RubyPack,
  options: ActiveRecordPackOptions,
): RubyPack {
  return {
    ...pack,
    storage: [...(pack.storage ?? []), ...activeRecordStorage(options)],
  };
}

export function activeRecordFramework(
  options: ActiveRecordPackOptions,
): RubyPack {
  return {
    name: "activerecord",
    protocol: options.storageSystem,
    discovery: [],
    storage: activeRecordStorage(options),
  };
}
