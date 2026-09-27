/**
 * Recognizes calls on a TypeORM repository that NestJS injects, and
 * records each one as a storage access on the entity's table.
 *
 *   constructor(@InjectRepository(Order) private orders: Repository<Order>)
 *
 * The pack says that `InjectRepository` supplies its parameter, so
 * `this.orders` reads as the decorator call. A call counts when its
 * receiver came from that call, and the table comes from the
 * `@Entity(...)` decorator on the class passed to it. The README
 * covers which methods count and what is left out.
 */

import { z } from "zod";

import { scopeOption, storageSystemOption } from "@suss/extractor";
import {
  constructedFrom,
  pack,
  sqlStatements,
  storageCalls,
} from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  CallOps,
  InputRule,
  PatternPack,
  SqlMethod,
  StatedRule,
  StorageMethod,
  ValueOps,
} from "@suss/recognize";

const NEST_MODULE = "@nestjs/typeorm";

const TYPEORM_MODULE = "typeorm";

const INJECT_REPOSITORY = "InjectRepository";

const INJECT_DATA_SOURCE = "InjectDataSource";

const INJECT_ENTITY_MANAGER = "InjectEntityManager";

const WHOLE_ROW = ["*"];

// ---------------------------------------------------------------------------
// Reading the columns out of each argument
// ---------------------------------------------------------------------------

/**
 * The columns a condition names. `where` can be a list of conditions,
 * any of which picks a row, so the columns are the ones any of them name.
 */
const CONDITION_COLUMNS: InputRule = ({ input }) => {
  const conditions = input.items();
  if (conditions.length === 0) {
    return keysOf(input);
  }
  return [...new Set(conditions.flatMap((condition) => keysOf(condition)))];
};

/**
 * `select` is a list of column names or a map of flags. A read that
 * selects nothing returns every column.
 */
const SELECTED: InputRule = ({ input }) => {
  const listed = input
    .items()
    .map((item) => item.text())
    .filter((name): name is string => name !== null);
  if (listed.length > 0) {
    return listed;
  }
  const flagged = keysOf(input, (value) => value.flag() !== false);
  return flagged.length > 0 ? flagged : WHOLE_ROW;
};

/**
 * The columns a saved entity sets, for one entity or a list of them. If
 * any entity cannot be read, the write counts as touching every column.
 */
const PAYLOAD: InputRule = ({ input }) => {
  const entities = input.items();
  if (entities.length === 0) {
    const written = keysOf(input);
    return written.length > 0 ? written : WHOLE_ROW;
  }
  const union = new Set<string>();
  for (const entity of entities) {
    const written = keysOf(entity);
    if (written.length === 0) {
      return WHOLE_ROW;
    }
    for (const name of written) {
      union.add(name);
    }
  }
  return [...union];
};

function keysOf(
  value: ValueOps,
  keep: (value: ValueOps) => boolean = () => true,
): string[] {
  const found: string[] = [];
  for (const entry of value.entries("nothing")) {
    if (entry.key !== null && keep(entry.value)) {
      found.push(entry.key);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Which argument each method reads
// ---------------------------------------------------------------------------

/** `find({ where, select })` and its siblings take one options object. */
const optionsWhere: StatedRule = {
  of: { at: 0, property: ["where"] },
  by: CONDITION_COLUMNS,
};
const optionsSelect: StatedRule = {
  of: { at: 0, property: ["select"] },
  by: SELECTED,
};

/** `findBy(where)` and the other `...By` methods take the condition itself. */
const condition = (at: number): StatedRule => ({
  of: { at },
  by: CONDITION_COLUMNS,
});
const payload = (at: number): StatedRule => ({ of: { at }, by: PAYLOAD });

// `count` and `exists` have no `fields`, since neither returns a column.
const REPOSITORY_METHODS: Record<string, StorageMethod> = {
  find: { kind: "read", selector: optionsWhere, fields: optionsSelect },
  findOne: { kind: "read", selector: optionsWhere, fields: optionsSelect },
  findOneOrFail: {
    kind: "read",
    selector: optionsWhere,
    fields: optionsSelect,
  },
  findAndCount: {
    kind: "read",
    selector: optionsWhere,
    fields: optionsSelect,
  },
  count: { kind: "read", selector: optionsWhere },
  exists: { kind: "read", selector: optionsWhere },
  findBy: { kind: "read", selector: condition(0), fields: WHOLE_ROW },
  findOneBy: { kind: "read", selector: condition(0), fields: WHOLE_ROW },
  findOneByOrFail: { kind: "read", selector: condition(0), fields: WHOLE_ROW },
  findAndCountBy: { kind: "read", selector: condition(0), fields: WHOLE_ROW },
  countBy: { kind: "read", selector: condition(0) },
  existsBy: { kind: "read", selector: condition(0) },
  save: { kind: "write", fields: payload(0) },
  insert: { kind: "write", fields: payload(0) },
  upsert: { kind: "write", fields: payload(0) },
  update: { kind: "write", selector: condition(0), fields: payload(1) },
  increment: { kind: "write", selector: condition(0), fields: { at: 1 } },
  decrement: { kind: "write", selector: condition(0), fields: { at: 1 } },
  delete: { kind: "write", selector: condition(0), fields: WHOLE_ROW },
  softDelete: { kind: "write", selector: condition(0), fields: WHOLE_ROW },
  restore: { kind: "write", selector: condition(0), fields: WHOLE_ROW },
  // `remove` takes loaded entities and deletes them by primary key, which
  // the call does not spell.
  remove: { kind: "write", fields: WHOLE_ROW },
  softRemove: { kind: "write", fields: WHOLE_ROW },
};

// ---------------------------------------------------------------------------
// The table behind the receiver
// ---------------------------------------------------------------------------

const ENTITY = constructedFrom({ from: [TYPEORM_MODULE], named: ["Entity"] });

/**
 * Checks in TypeORM's own order: the name `@Entity` states, as its
 * first argument or as `name` in its options, then the class name under
 * TypeORM's default naming.
 */
function tableOf(_selector: readonly string[], call: CallOps): string | null {
  const entity = call.receiver()?.classAt?.(0) ?? null;
  if (entity === null) {
    return null;
  }
  const decorator = entity.decorator(ENTITY);
  const stated =
    decorator?.propertyAt(0, "name", "nothing") ??
    decorator?.nameAt(0, "nothing") ??
    null;
  if (stated !== null) {
    return stated;
  }
  const className = entity.name();
  return className === null ? null : snakeCase(className);
}

/** TypeORM's default naming strategy: `OrderLine` is `order_line`. */
function snakeCase(name: string): string {
  return name
    .replace(/([A-Z])([A-Z])([a-z])/g, "$1_$2$3")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * The options a `-f typeorm=config.json` file may set. The CLI checks
 * the file against this schema before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * The storage system the calls target, `"postgresql"` when unset. It
     * has to match the other side's `storageSystem`, or the calls do not
     * pair.
     */
    storageSystem: storageSystemOption.optional(),
    /** Scope for the storage binding, `"default"` when unset. */
    scope: scopeOption.optional(),
  })
  .strict();

export type TypeormRecognizerOptions = z.infer<typeof optionsSchema>;

function repositoryCalls(options: TypeormRecognizerOptions) {
  return storageCalls({
    system: options.storageSystem ?? "postgresql",
    scope: options.scope ?? "default",
    client: constructedFrom({
      from: [NEST_MODULE],
      named: [INJECT_REPOSITORY],
    }),
    unsettledName: "nothing",
  })
    .methods(REPOSITORY_METHODS)
    .container(tableOf)
    .example('this.orders.find({ where: { status: "open" } })');
}

const STATEMENT: SqlMethod = { statement: { at: 0 } };

/**
 * `query` on an injected data source or entity manager runs the SQL it
 * is handed, so the statement is the only place its tables show up.
 */
function rawStatements(options: TypeormRecognizerOptions) {
  const system = options.storageSystem ?? "postgresql";
  return sqlStatements({
    system,
    dialect: system,
    scope: options.scope ?? "default",
    client: constructedFrom({
      from: [NEST_MODULE],
      named: [INJECT_DATA_SOURCE, INJECT_ENTITY_MANAGER],
    }),
  })
    .methods({ query: STATEMENT })
    .example('this.source.query("SELECT id FROM orders")');
}

/**
 * The repositories, data sources and entity managers NestJS injects by
 * decorator. The pack discovers no units: each call becomes an effect in
 * a unit another pack found.
 */
export function typeormFramework(
  options: TypeormRecognizerOptions = {},
): PatternPack {
  return {
    ...pack("typeorm", [repositoryCalls(options), rawStatements(options)], {
      languages: ["typescript", "javascript"],
      recognizedAs: "@suss/framework-typeorm",
      protocol: "in-process",
    }),
    parameterSuppliers: [
      INJECT_REPOSITORY,
      INJECT_DATA_SOURCE,
      INJECT_ENTITY_MANAGER,
    ].map((name) => ({ module: NEST_MODULE, name })),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-typeorm",
  dependencies: [{ ecosystem: "npm", name: NEST_MODULE }],
  reads:
    "TypeORM repositories that NestJS injects with `@InjectRepository`. Each read and write becomes a storage-access interaction on the entity's table, and a `query` on an injected data source or entity manager is read as SQL.",
};

export default typeormFramework;
