/**
 * Records which calls a Ruby body makes against the database, for a
 * project on Rails. The adapter matches a call by what its receiver's
 * class extends, and the README explains why.
 */

import { z } from "zod";

import { storageSystemOption } from "@suss/extractor";
import {
  association,
  callback,
  classBody,
  definesMethod,
} from "@suss/recognize";

import { storageSystemFromDatabaseYml } from "./databaseYml.js";

import type {
  RbBodyBlock,
  RbRawSqlPattern,
  RbStoragePattern,
  RubyPack,
} from "@suss/adapter-ruby";
import type { ClassBodyArgument, ClassBodyDeclaration } from "@suss/extractor";
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
  create_or_find_by: ["create"],
  "create_or_find_by!": ["create"],
  save: ["create", "update"],
  "save!": ["create", "update"],
  // These two save the record, skipping validation.
  update_attribute: ["create", "update"],
  "toggle!": ["create", "update"],
  update: ["update"],
  "update!": ["update"],
  touch: ["update"],
  upsert: ["create", "update"],
  destroy: ["destroy"],
  "destroy!": ["destroy"],
  destroy_all: ["destroy"],
  destroy_by: ["destroy"],
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

/** Where an association call writes the class it reaches, when the name alone would not say. */
const CLASS_NAME: ClassBodyArgument = { keyword: "class_name" };

/**
 * What a model's body declares, read in the classes that reach
 * `ActiveRecord::Base` and in the concerns they include. A serializer
 * writes `has_many` too, and declares nothing about the database.
 */
export function activeRecordClassBodies(): ClassBodyDeclaration[] {
  const callbacks = Object.fromEntries(
    Object.entries(REGISTERED_BY).map(([registers, events]) => [
      registers,
      callback({
        methods: { from: 0 },
        events,
        narrowedBy: { keyword: "on" },
      }),
    ]),
  );
  return [
    classBody({
      in: [{ from: ["ActiveRecord"], named: ["Base"] }],
      calls: {
        has_one: association({ name: { at: 0 }, target: CLASS_NAME }),
        belongs_to: association({ name: { at: 0 }, target: CLASS_NAME }),
        has_many: association({
          name: { at: 0 },
          target: CLASS_NAME,
          plural: true,
        }),
        has_and_belongs_to_many: association({
          name: { at: 0 },
          target: CLASS_NAME,
          plural: true,
        }),
        ...callbacks,
        scope: definesMethod({ name: { at: 0 }, body: { at: 1 } }),
      },
    }),
  ];
}

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
        "insert!",
        "insert_all",
        "insert_all!",
        "update",
        "update!",
        "update_all",
        "update_attribute",
        "update_column",
        "update_columns",
        "upsert",
        "upsert_all",
        "save",
        "save!",
        "destroy",
        "destroy!",
        "destroy_all",
        "destroy_by",
        "delete",
        "delete_all",
        "delete_by",
        "touch",
        "touch_all",
        "increment!",
        "decrement!",
        "toggle!",
        "update_counters",
        "increment_counter",
        "decrement_counter",
        "reset_counters",
        // These read first and store only when the read found nothing,
        // or store first and read when the store was refused, and a write
        // is the stronger of the two claims.
        "find_or_create_by",
        "find_or_create_by!",
        "create_or_find_by",
        "create_or_find_by!",
      ],
      reads: READS,
      givesBack: [...RETURNS_A_RECORD, ...RETURNS_A_RELATION],
      byPrimaryKey: {
        methods: ["find", "exists?", "update", "destroy", "delete"],
        column: "id",
      },
      statements: TAKES_A_STATEMENT,
      bindPlaceholder: "?",
      callbacks: { eventOf: EVENT_OF },
      columnArguments: ["select", "pluck", "pick"],
      storageSystem: options.storageSystem,
      raises: [
        {
          exception: "ActiveRecord::RecordNotFound",
          methods: [
            "find",
            "find_by!",
            "find_sole_by",
            "sole",
            "first!",
            "last!",
            "take!",
          ],
        },
        {
          exception: "ActiveRecord::RecordInvalid",
          methods: ["save!", "create!", "update!", "find_or_create_by!"],
        },
      ],
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
 * The ActiveSupport blocks a model's declarations are written in, whose
 * statements run as part of the class or module body: a concern's
 * `included do`, and `with_options do`. ActiveRecord brings ActiveSupport
 * with it, so a run without the rails pack still reads them.
 */
export const ACTIVE_SUPPORT_BODY_BLOCKS: readonly RbBodyBlock[] = [
  { name: "included", moduleOnly: true },
  { name: "with_options" },
];

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
    classBodies: [...(pack.classBodies ?? []), ...activeRecordClassBodies()],
    bodyBlocks: [...(pack.bodyBlocks ?? []), ...ACTIVE_SUPPORT_BODY_BLOCKS],
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
    version: "2",
    protocol: options.storageSystem,
    discovery: [],
    storage: activeRecordStorage(options),
    classBodies: activeRecordClassBodies(),
    bodyBlocks: [...ACTIVE_SUPPORT_BODY_BLOCKS],
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
    readFromProject: storageSystemFromDatabaseYml,
    databaseOption: "storageSystem",
  },
};

export default activeRecordFramework;
