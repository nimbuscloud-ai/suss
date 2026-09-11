// @suss/framework-activerecord: which calls a Ruby body makes against the
// database, for a project on Rails. The adapter matches a call by what its
// receiver inherits, and the README says why ancestry.

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";

import type { RbStoragePattern, RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * What `-f activerecord=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * Which database is behind the connection. ActiveRecord talks to all of
     * them and database.yml says which, so the project supplies this.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type ActiveRecordPackOptions = z.infer<typeof optionsSchema>;

/** Methods that hand back one record of the model they were called on. */
const RETURNS_A_RECORD = [
  "find",
  "find_by",
  "find_by!",
  "find_or_create_by",
  "find_or_create_by!",
  "find_or_initialize_by",
  "first",
  "first!",
  "last",
  "last!",
  "take",
  "take!",
  "sole",
  "find_sole_by",
  "new",
  "build",
  "create",
  "create!",
  "reload",
];

/**
 * Methods that run a query the moment they are called: the finders, and the
 * terminals that make a relation fetch its rows.
 */
const RUNS_A_QUERY = [
  "find",
  "find_by",
  "find_by!",
  "find_sole_by",
  "sole",
  "first",
  "first!",
  "last",
  "last!",
  "take",
  "take!",
  "exists?",
  "count",
  "size",
  "any?",
  "none?",
  "many?",
  "empty?",
  "pluck",
  "pick",
  "ids",
  "sum",
  "average",
  "minimum",
  "maximum",
  "calculate",
  "to_a",
  "each",
  "map",
  "find_each",
  "find_in_batches",
  "in_batches",
  "load",
  "reload",
  "find_or_initialize_by",
];

/** Methods that hand back a relation, which a later read narrows to one record. */
const RETURNS_A_RELATION = [
  "where",
  "rewhere",
  "or",
  "order",
  "reorder",
  "limit",
  "offset",
  "includes",
  "preload",
  "eager_load",
  "joins",
  "left_joins",
  "left_outer_joins",
  "distinct",
  "select",
  "group",
  "having",
  "merge",
  "readonly",
  "lock",
  "none",
  "all",
  "unscoped",
  "unscope",
  "extending",
  "from",
  "references",
  "only",
  "except",
];

/**
 * A relation builder runs no query until something asks it for rows, but a
 * body that writes one is asking for what it narrows to, so the builders
 * count as reads alongside the terminals. `where.not(...)` hangs off a bare
 * `where`, so the negation is a method of its own rather than a keyword on
 * the call before it.
 */
const READS = [...RUNS_A_QUERY, ...RETURNS_A_RELATION, "not"];

/**
 * The base class the library gives a model, the methods that read the
 * database and the methods that change what is stored. Everything here is
 * ActiveRecord's own. A project's `ApplicationRecord` is matched by
 * following what it extends, so nothing about any project belongs in
 * these lists.
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
        // These two read first and store only when the read found
        // nothing, and a write is the stronger of the two claims.
        "find_or_create_by",
        "find_or_create_by!",
      ],
      reads: READS,
      givesBack: [...RETURNS_A_RECORD, ...RETURNS_A_RELATION],
      byPrimaryKey: {
        methods: ["find", "exists?", "update", "destroy", "delete"],
        column: "id",
      },
      columnArguments: ["select", "pluck", "pick"],
      associations: {
        singular: ["has_one", "belongs_to"],
        plural: ["has_many", "has_and_belongs_to_many"],
        classNameKeyword: "class_name",
      },
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
  // The CLI passes on a config somebody wrote by hand, with nothing
  // typed in front of it, so it can arrive here unset.
  if (typeof options?.storageSystem !== "string") {
    throw new Error(
      "it needs `storageSystem`, which database is behind the connection: postgresql, mysql, or sqlite. ActiveRecord talks to all of them and database.yml settles which, so the pack cannot.",
    );
  }
  return {
    name: "activerecord",
    protocol: options.storageSystem,
    discovery: [],
    storage: activeRecordStorage(options),
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-activerecord",
  dependencies: [
    { ecosystem: "rubygems", name: "activerecord" },
    { ecosystem: "rubygems", name: "rails" },
  ],
  reads:
    "ActiveRecord calls (Ruby): a call matches when its method is one ActiveRecord defines as a read or a write and the class behind its receiver reaches \`ActiveRecord::Base\`, following what each class extends through the project.",
  configuration: {
    file: "suss.activerecord.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the connection: postgresql, mysql, or sqlite. ActiveRecord talks to all of them and database.yml settles which, so the pack cannot.",
  },
};

export default activeRecordFramework;
