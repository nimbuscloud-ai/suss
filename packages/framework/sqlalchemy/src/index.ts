/**
 * The calls a Python body makes against the database through SQLAlchemy.
 * The adapter matches a call chain by the declared return type of the
 * method behind it, and the README explains why.
 */

import { z } from "zod";

import { pooledWords, storageSystemOption } from "@suss/extractor";
import {
  classBody,
  imported,
  pack,
  sqlStatements,
  storageCalls,
  typed,
} from "@suss/recognize";

import type { PythonPack } from "@suss/adapter-python";
import type { ClassBodyDeclaration, PackWords } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type {
  CallStep,
  ClassContainer,
  ClassNaming,
  ClassPick,
  ConditionsPick,
  Match,
  NamePick,
  ParameterPick,
  PatternPack,
  ReceiverOrigin,
  StorageMethod,
  ToReceiver,
} from "@suss/recognize";

/**
 * The CLI checks a `-f sqlalchemy=config.json` file against this schema
 * before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * Which database is behind the engine. SQLAlchemy works with several,
     * and the connection URL picks one, so the project has to set this.
     */
    storageSystem: storageSystemOption,
  })
  .strict();

export type SqlalchemyPackOptions = z.infer<typeof optionsSchema>;

/** The calls that say which table a statement reads when its first argument did not. */
export const TABLE_METHODS = ["select_from", "join"];

/** SQLAlchemy has several ways to declare a base, and every mapped class inherits from one of these. */
const MODEL_BASE_NAMES = [
  "DeclarativeBase",
  "declarative_base",
  "DeclarativeBaseNoMeta",
];

/** These return a query over the same model, so the chain stays on that model. */
const NARROWS_A_QUERY = [
  "filter",
  "filter_by",
  "where",
  "order_by",
  "limit",
  "offset",
  "options",
  "join",
  "outerjoin",
  "distinct",
  "group_by",
  "having",
];

const RUNS_A_QUERY = [
  "first",
  "one",
  "one_or_none",
  "scalar",
  "scalar_one",
  "scalar_one_or_none",
  "scalars",
  "get",
  "all",
];

/** Session methods whose first argument settles which model the result is. */
const SESSION_ENTRY_METHODS = [
  { method: "get", argument: 0 },
  { method: "query", argument: 0 },
  { method: "execute", argument: 0 },
];

/** The calls that give back one of a model class, as a library writes them. */
export interface ModelCalls {
  /** The names a model's base classes lead back to. */
  readonly baseNames: readonly string[];
  /** Methods whose result is the model again. */
  readonly givesBack: readonly string[];
  /** Methods handed the model class at `argument` that give back one of it. */
  readonly entryMethods: readonly { method: string; argument: number }[];
  /** Functions a module exports that do the same. */
  readonly entryFunctions: readonly {
    module: string;
    name: string;
    argument: number;
  }[];
}

/**
 * SQLAlchemy's calls that give back the mapped class they were passed,
 * so a method called on the result resolves to the one the project's
 * model declares. `session.execute(stmt)` takes a statement instead of
 * the class, but the statement has already settled on one model, so the
 * rules treat the two the same way.
 */
export const SQLALCHEMY_MODEL_CALLS: ModelCalls = {
  baseNames: MODEL_BASE_NAMES,
  givesBack: [...NARROWS_A_QUERY, ...RUNS_A_QUERY],
  entryMethods: SESSION_ENTRY_METHODS,
  entryFunctions: [{ module: "sqlalchemy", name: "select", argument: 0 }],
};

/** The words the shared rules read the calls as, for every base a model can have. */
export function modelWords(calls: ModelCalls): PackWords {
  return {
    givesBackOne: calls.baseNames.flatMap((base) =>
      calls.givesBack.map((method) => ({ base, method })),
    ),
    givesBackOneOfArgument: calls.baseNames.flatMap((base) =>
      calls.entryMethods.map((entry) => ({ base, ...entry })),
    ),
    givesBackOneOfImport: [...calls.entryFunctions],
  };
}

/**
 * A model field assigned from `relationship(...)` reaches another model.
 * The callable has to come from the library, so a project function with
 * the same name does not count.
 */
export function sqlalchemyClassBodies(): ClassBodyDeclaration[] {
  return [
    classBody({
      fields: {
        association: {
          madeBy: imported({
            from: ["sqlalchemy.orm"],
            named: ["relationship"],
          }),
        },
      },
    }),
  ];
}

// The statement `text(sql)` is handed goes where the call that runs it
// says: `.bindparams(tenant=t)` on the statement, or the argument after
// it, `session.execute(text(sql), {"tenant": t})`, or under `params=`.
const BIND_PARAMETERS: readonly ParameterPick[] = [
  { of: [{ to: "chained", method: "bindparams" }], keywords: true },
  { of: [{ to: "passedTo", at: 0 }], at: 1, keyword: "params" },
  {
    of: [
      { to: "chained", method: "bindparams" },
      { to: "passedTo", at: 0 },
    ],
    at: 1,
    keyword: "params",
  },
];

/**
 * `text(sql)`, imported from `module`, is how a project hands the
 * library a statement it wrote itself. The access is recognized under
 * the module the call imported `text` from.
 */
export function rawStatements(
  module: string,
  options: SqlalchemyPackOptions,
): PatternPack {
  const statements = sqlStatements({
    system: options.storageSystem,
    dialect: options.storageSystem,
    client: imported({ from: [module], named: ["text"] }),
  })
    .calls({ statement: { at: 0 }, parameters: BIND_PARAMETERS })
    .example('text("SELECT id FROM users")');
  return pack(`${module}-text`, [statements], {
    languages: ["python"],
    recognizedAs: `python-${module}`,
    version: PACK_VERSION,
  });
}

/**
 * One of the library's query types, as the chains on it read them: the
 * module it comes from, the methods that write, the methods that record
 * nothing when a chain starts with them, and the methods that supply
 * values rather than pick rows.
 */
export interface QueryTypes {
  readonly module: string;
  readonly types: readonly string[];
  readonly writes: readonly string[];
  readonly recordsNothing?: readonly string[];
  readonly values?: readonly string[];
}

/** SQLAlchemy's writes on a session and on a query. */
export const SESSION_WRITES = [
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
 * `execute` and the scalar calls run a statement whose own chain is read
 * already, and the rest only manage the session.
 */
export const SESSION_RECORDS_NOTHING = [
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

/** SQLAlchemy's session and query, and its statements. */
export const SQLALCHEMY_TYPES: readonly QueryTypes[] = [
  {
    module: "sqlalchemy.orm",
    types: ["Query", "Session"],
    writes: SESSION_WRITES,
    recordsNothing: SESSION_RECORDS_NOTHING,
  },
  {
    module: "sqlalchemy",
    types: ["Select", "Update", "Delete", "Insert"],
    writes: ["update", "delete", "insert", "commit"],
    values: ["values"],
  },
];

/** The calls that join two or more conditions into one. */
const COMBINED_BY = ["and_", "or_", "not_"];

const CHAIN_START: CallStep = { to: "chainStart" };

/** A mapped class is stored in the table its `__tablename__` says, and otherwise the chain names it by the class. */
const TABLE_NAMING: readonly ClassNaming[] = [
  { attribute: "__tablename__" },
  "className",
];

/** What a chain reads, the class it works on and the names it states for each kind of access. */
interface ChainReading {
  readonly model: ClassPick;
  readonly reads: StorageMethod;
  readonly writes: StorageMethod;
}

/** The container a chain stores to: the class the model pick finds, by its table. */
function tableOf(model: ClassPick): ClassContainer {
  return { ...model, named: TABLE_NAMING };
}

/**
 * How a chain is read, from its last call back to its first call on
 * `origin`, the calls after that first call picking rows. The container
 * is the class the first call is passed, or the one a `select_from` or
 * `join` after it is passed, or the class the chain is called on.
 */
function chainReading(
  origin: ReceiverOrigin,
  values: readonly string[],
  libraries: readonly string[],
): ChainReading {
  const later: ToReceiver = {
    to: "receiver",
    every: true,
    inPlace: true,
    until: origin,
  };
  const model: ClassPick = {
    class: [
      { of: [CHAIN_START], at: 0 },
      { of: [{ ...later, method: TABLE_METHODS }], itself: true, at: 0 },
      { of: [CHAIN_START], receiver: true },
    ],
    notFrom: libraries,
  };
  // A keyword is a column only in a call that supplies values, the
  // chain's first call included. A session method's keywords are its
  // options, and a project function's are its parameters.
  const valuesKeywords: NamePick[] = [
    { keywordsOf: { of: [{ to: "chainStart", method: values }] } },
    { keywordsOf: { of: [{ ...later, method: values }], itself: true } },
  ];
  const fields: NamePick[] = [
    { columns: { of: [CHAIN_START], from: 0 }, ofClass: model },
    ...(values.length === 0 ? [] : valuesKeywords),
  ];
  const selector: ConditionsPick = {
    conditions: {
      of: [values.length === 0 ? later : { ...later, except: values }],
      itself: true,
    },
    ofClass: model,
    combinedBy: COMBINED_BY,
    pinnedBy: ["and_"],
    equality: ["=="],
  };
  return {
    model,
    reads: { kind: "read", fields, selector },
    writes: { kind: "write", fields, selector },
  };
}

/**
 * The chains of calls on one of the query types, each read once at its
 * last call: `db.query(User).filter(User.id == x).first()`, or
 * `db.add(user)` alone. A chain's first call is made on the session, or
 * is the session when a project method returns one, `Orders.query()`.
 * A chain whose first call records nothing,
 * `db.execute(stmt).scalars().all()`, still matches.
 */
export function queryCalls(
  types: QueryTypes,
  libraries: readonly string[],
  storageSystem: string,
): Match[] {
  const session = typed({ from: [types.module], named: types.types });
  const recordsNothing = types.recordsNothing ?? [];
  const onSession: CallStep[] = [
    {
      to: "chainStart",
      ...(recordsNothing.length === 0 ? {} : { except: recordsNothing }),
    },
    { to: "chained", fromItself: true, every: true },
  ];
  const { model, reads, writes } = chainReading(
    session,
    types.values ?? [],
    libraries,
  );
  const accesses = storageCalls(
    {
      system: storageSystem,
      client: session,
      clientAt: onSession,
      unsettledName: "nothing",
    },
    { outermost: true },
  )
    .methods(Object.fromEntries(types.writes.map((name) => [name, writes])))
    .otherwise(reads)
    .container(tableOf(model))
    .example("db.query(User).filter(User.id == 1).first()");
  if (recordsNothing.length === 0) {
    return [accesses];
  }
  const nothing = storageCalls(
    { system: storageSystem, client: session, unsettledName: "nothing" },
    { outermost: true },
  )
    .about(CHAIN_START)
    .methods(
      Object.fromEntries(
        recordsNothing.map((name) => [name, { kind: "nothing" }] as const),
      ),
    )
    .example("db.execute(stmt).scalars().all()");
  return [accesses, nothing];
}

/**
 * The statements a file builds with a function it imports from one of
 * `modules`, each read once at its last call: `select(User.id).where(...)`
 * or `update(User).where(...).values(name=x)`. The function says what the
 * statement does however the chain ends, and the calls after it pick rows
 * and supply values the way a query's do.
 */
export function statementCalls(
  modules: readonly string[],
  libraries: readonly string[],
  storageSystem: string,
): Match {
  const statement = imported({
    from: modules,
    named: ["select", "insert", "update", "delete"],
  });
  const { model, reads, writes } = chainReading(
    statement,
    ["values"],
    libraries,
  );
  return storageCalls(
    {
      system: storageSystem,
      client: statement,
      clientAt: [CHAIN_START],
      unsettledName: "nothing",
    },
    { outermost: true },
  )
    .methods(
      { select: reads, insert: writes, update: writes, delete: writes },
      { of: [CHAIN_START] },
    )
    .container(tableOf(model))
    .example("select(User.id).where(User.id == 1)");
}

/**
 * The chains on each query type. A value declared as a type from any of
 * the packages the types come from is a statement or a column rather
 * than a model. The accesses are recognized as `python-storage`, the
 * name the adapter merges a body's storage accesses under.
 */
export function queryChains(
  name: string,
  types: readonly QueryTypes[],
  options: SqlalchemyPackOptions,
  models: ModelsSaid,
): PatternPack {
  const libraries = topPackages(types.map((one) => one.module));
  return pack(
    name,
    types.flatMap((one) => queryCalls(one, libraries, options.storageSystem)),
    {
      languages: ["python"],
      recognizedAs: "python-storage",
      version: PACK_VERSION,
      words: models.words,
      classBodies: models.classBodies,
    },
  );
}

/** What a pack says about its models beside the chains: what its calls give back, and what a class body reaches. */
export interface ModelsSaid {
  readonly words: PackWords;
  readonly classBodies: ClassBodyDeclaration[];
}

/** The build of this pack and of SQLModel's, which the extraction cache keys on. */
export const PACK_VERSION = "1";

/** The statements built with a function imported from one of the modules, recognized as the chains on a query are. */
export function statementChains(
  name: string,
  modules: readonly string[],
  options: SqlalchemyPackOptions,
): PatternPack {
  return pack(
    name,
    [statementCalls(modules, topPackages(modules), options.storageSystem)],
    {
      languages: ["python"],
      recognizedAs: "python-storage",
      version: PACK_VERSION,
    },
  );
}

/** The packages the modules are in, `sqlalchemy` for `sqlalchemy.orm`. */
function topPackages(modules: readonly string[]): string[] {
  return [...new Set(modules.map((one) => one.split(".")[0] ?? one))];
}

/** The hooks, class bodies and words of each pack, put after the ones the route pack already has. */
export function withStatements(
  base: PythonPack,
  packs: readonly PatternPack[],
): PythonPack {
  return {
    ...base,
    invocationRecognizers: [
      ...(base.invocationRecognizers ?? []),
      ...packs.flatMap((one) => one.invocationRecognizers ?? []),
    ],
    accessRecognizers: [
      ...(base.accessRecognizers ?? []),
      ...packs.flatMap((one) => one.accessRecognizers ?? []),
    ],
    classBodies: [
      ...(base.classBodies ?? []),
      ...packs.flatMap((one) => one.classBodies ?? []),
    ],
    words: pooledWords([base, ...packs]),
  };
}

/**
 * Adds the storage chains to the route pack a run already uses, since a
 * project picks its web framework and its database library separately.
 */
export function withSqlalchemy(
  pack: PythonPack,
  options: SqlalchemyPackOptions,
): PythonPack {
  return withStatements(pack, [
    rawStatements("sqlalchemy", options),
    queryChains("sqlalchemy-queries", SQLALCHEMY_TYPES, options, {
      words: modelWords(SQLALCHEMY_MODEL_CALLS),
      classBodies: sqlalchemyClassBodies(),
    }),
    statementChains("sqlalchemy-statements", ["sqlalchemy"], options),
  ]);
}

export function sqlalchemyFramework(
  options: SqlalchemyPackOptions,
): PythonPack {
  // A bare `-f sqlalchemy` skips the CLI's schema check, so the options
  // can arrive here without `storageSystem`.
  if (typeof options?.storageSystem !== "string") {
    throw new Error(
      "it needs `storageSystem`, which database is behind the engine: postgresql, mysql, or sqlite. SQLAlchemy talks to all of them and the connection URL settles which, so the pack cannot.",
    );
  }
  return withSqlalchemy(
    {
      name: "sqlalchemy",
      version: PACK_VERSION,
      protocol: options.storageSystem,
      discovery: [],
    },
    options,
  );
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-sqlalchemy",
  dependencies: [{ ecosystem: "pypi", name: "sqlalchemy" }],
  reads: `SQLAlchemy calls (Python). The pack declares which types a query returns and which methods write. The adapter matches a call chain by following a project's own base class to the method behind the call, and reads that method's declared return type.`,
  configuration: {
    file: "suss.sqlalchemy.json",
    example: { storageSystem: "postgresql" },
    required: true,
    why: "which database is behind the engine: postgresql, mysql, or sqlite. SQLAlchemy talks to all of them and the connection URL settles which, so the pack cannot.",
    databaseOption: "storageSystem",
  },
};

export default sqlalchemyFramework;
