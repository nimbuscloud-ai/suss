/**
 * Records which calls a Ruby body makes against the database, for a
 * project on Rails. The adapter matches a call by what its receiver's
 * class extends, and the README explains why.
 */

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";

import type {
  RbRawSqlPattern,
  RbStoragePattern,
  RubyPack,
} from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * The CLI checks a `-f activerecord=config.json` file against this schema
 * before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * The database behind the connection. ActiveRecord works with several,
     * and database.yml picks one, so the project has to supply it.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type ActiveRecordPackOptions = z.infer<typeof optionsSchema>;

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
 * A relation builder runs no query by itself, but code only builds one to
 * fetch the rows it narrows to, so the builders count as reads. `not` is
 * listed separately because `where.not(...)` calls it on a bare `where`.
 */
const READS = [...RUNS_A_QUERY, ...RETURNS_A_RELATION, "not"];

/**
 * Both take the statement first, either alone or at the head of an array
 * followed by the bind values.
 */
const TAKES_A_STATEMENT = {
  find_by_sql: { at: 0 },
  count_by_sql: { at: 0 },
};

const CONNECTION_STATEMENTS = {
  execute: { at: 0 },
  exec_query: { at: 0 },
  exec_insert: { at: 0 },
  exec_update: { at: 0 },
  exec_delete: { at: 0 },
  select_all: { at: 0 },
  select_one: { at: 0 },
  select_value: { at: 0 },
  select_values: { at: 0 },
  select_rows: { at: 0 },
};

/**
 * The callback events each write runs. `save` runs the create or the
 * update callbacks depending on whether the record was stored before, so
 * it lists both.
 */
const EVENT_OF: Record<string, string[]> = {
  create: ["create"],
  "create!": ["create"],
  find_or_create_by: ["create"],
  "find_or_create_by!": ["create"],
  save: ["create", "update"],
  "save!": ["create", "update"],
  update: ["update"],
  "update!": ["update"],
  touch: ["update"],
  upsert: ["create", "update"],
  destroy: ["destroy"],
  "destroy!": ["destroy"],
  destroy_all: ["destroy"],
};

/**
 * The events a callback runs on when its registering call has no `on:`
 * keyword. The bulk writers are missing from `EVENT_OF` because
 * ActiveRecord runs no callbacks for them.
 */
const REGISTERED_BY: Record<string, string[]> = {
  before_validation: ["create", "update"],
  after_validation: ["create", "update"],
  before_save: ["create", "update"],
  around_save: ["create", "update"],
  after_save: ["create", "update"],
  before_create: ["create"],
  around_create: ["create"],
  after_create: ["create"],
  before_update: ["update"],
  around_update: ["update"],
  after_update: ["update"],
  before_destroy: ["destroy"],
  around_destroy: ["destroy"],
  after_destroy: ["destroy"],
  after_commit: ["create", "update", "destroy"],
  after_rollback: ["create", "update", "destroy"],
  after_create_commit: ["create"],
  after_update_commit: ["update"],
  after_destroy_commit: ["destroy"],
};

/**
 * Every name here is ActiveRecord's own. A project's `ApplicationRecord`
 * is matched by following what it extends, so no project class goes in
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
      statements: TAKES_A_STATEMENT,
      bindPlaceholder: "?",
      callbacks: {
        eventOf: EVENT_OF,
        registeredBy: REGISTERED_BY,
        eventKeyword: "on",
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
 * Statements run through the connection. `ActiveRecord::Base.connection`,
 * `Account.connection` and a bare `connection` inside a model's class
 * method all reach the same store. The SQL dialect is the database the
 * project set in `storageSystem`.
 */
export function activeRecordRawSql(
  options: ActiveRecordPackOptions,
): RbRawSqlPattern[] {
  return [
    {
      constantName: "ActiveRecord::Base",
      baseClasses: ["ActiveRecord::Base"],
      clientBuilders: ["connection", "lease_connection", "retrieve_connection"],
      statements: CONNECTION_STATEMENTS,
      storageSystem: options.storageSystem,
      dialect: options.storageSystem,
    },
  ];
}

/**
 * Adds the storage patterns to the pack a run already uses. A project
 * picks its GraphQL library and its database library separately, so this
 * keeps everything the pack already has.
 */
export function withActiveRecord(
  pack: RubyPack,
  options: ActiveRecordPackOptions,
): RubyPack {
  return {
    ...pack,
    storage: [...(pack.storage ?? []), ...activeRecordStorage(options)],
    rawSql: [...(pack.rawSql ?? []), ...activeRecordRawSql(options)],
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
    rawSql: activeRecordRawSql(options),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-activerecord",
  dependencies: [
    { ecosystem: "rubygems", name: "activerecord" },
    { ecosystem: "rubygems", name: "rails" },
  ],
  reads:
    "ActiveRecord calls (Ruby): a call matches when its method is one ActiveRecord defines as a read or a write and the class behind its receiver reaches \`ActiveRecord::Base\`, following what each class extends through the project. Statements the project wrote itself are read for the tables they touch, whether they went through \`find_by_sql\` and \`count_by_sql\` or through the connection. A write also runs the model's callbacks, and what they reach is recorded on the body that did the write.",
  configuration: {
    file: "suss.activerecord.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the connection: postgresql, mysql, or sqlite. ActiveRecord talks to all of them and database.yml settles which, so the pack cannot.",
  },
};

export default activeRecordFramework;
