/**
 * The storage chains the SQLAlchemy pack declares, built from a short
 * description of each library type or statement function, for a test
 * that needs a session, a query or a statement read the way the pack
 * reads one. The shipped pack depends on this package, so a test here
 * declares the chains itself, and the pack's own tests cover how they
 * read.
 */

import { imported, pack, storageCalls, typed } from "@suss/recognize";

import type {
  CallStep,
  ClassContainer,
  ClassPick,
  Match,
  NamePick,
  ReceiverOrigin,
  StorageMethod,
  ToReceiver,
} from "@suss/recognize";
import type { PythonPack } from "../pack.js";

/** One library's query types or statement functions, and what their methods do. */
export interface TestStorage {
  readonly module: string;
  /** The types a session or query is declared as. */
  readonly types?: readonly string[];
  /** The functions a statement is built with, which say what it does. */
  readonly functions?: readonly string[];
  readonly writes: readonly string[];
  readonly recordsNothing?: readonly string[];
  readonly values?: readonly string[];
}

const START: CallStep = { to: "chainStart" };

/** A mapped class is stored in the table its `__tablename__` says, as the pack names it. */
function tableOf(model: ClassPick): ClassContainer {
  return { ...model, named: [{ attribute: "__tablename__" }, "className"] };
}

function reading(
  origin: ReceiverOrigin,
  values: readonly string[],
  libraries: readonly string[],
): { model: ClassPick; reads: StorageMethod; writes: StorageMethod } {
  const later: ToReceiver = {
    to: "receiver",
    every: true,
    inPlace: true,
    until: origin,
  };
  const model: ClassPick = {
    class: [
      { of: [START], at: 0 },
      {
        of: [{ ...later, method: ["select_from", "join"] }],
        itself: true,
        at: 0,
      },
      { of: [START], receiver: true },
    ],
    notFrom: libraries,
  };
  const valuesKeywords: NamePick[] = [
    { keywordsOf: { of: [{ to: "chainStart", method: values }] } },
    { keywordsOf: { of: [{ ...later, method: values }], itself: true } },
  ];
  const fields: NamePick[] = [
    { columns: { of: [START], from: 0 }, ofClass: model },
    ...(values.length === 0 ? [] : valuesKeywords),
  ];
  const selector: NamePick = {
    conditions: {
      of: [values.length === 0 ? later : { ...later, except: values }],
      itself: true,
    },
    ofClass: model,
    combinedBy: ["and_", "or_", "not_"],
    pinnedBy: ["and_"],
    equality: ["=="],
  };
  return {
    model,
    reads: { kind: "read", fields, selector },
    writes: { kind: "write", fields, selector },
  };
}

function sessionCalls(
  one: TestStorage,
  types: readonly string[],
  libraries: readonly string[],
): Match[] {
  const session = typed({ from: [one.module], named: types });
  const nothing = one.recordsNothing ?? [];
  const { model, reads, writes } = reading(
    session,
    one.values ?? [],
    libraries,
  );
  const accesses = storageCalls(
    {
      system: "postgresql",
      client: session,
      clientAt: [
        {
          to: "chainStart",
          ...(nothing.length === 0 ? {} : { except: nothing }),
        },
        { to: "chained", fromItself: true, every: true },
      ],
      unsettledName: "nothing",
    },
    { outermost: true },
  )
    .methods(Object.fromEntries(one.writes.map((name) => [name, writes])))
    .otherwise(reads)
    .container(tableOf(model));
  if (nothing.length === 0) {
    return [accesses];
  }
  const silent = storageCalls(
    { system: "postgresql", client: session, unsettledName: "nothing" },
    { outermost: true },
  )
    .about(START)
    .methods(
      Object.fromEntries(
        nothing.map((name) => [name, { kind: "nothing" }] as const),
      ),
    );
  return [accesses, silent];
}

function statementCalls(
  one: TestStorage,
  functions: readonly string[],
  libraries: readonly string[],
): Match {
  const statement = imported({ from: [one.module], named: functions });
  const { model, reads, writes } = reading(
    statement,
    one.values ?? [],
    libraries,
  );
  return storageCalls(
    {
      system: "postgresql",
      client: statement,
      clientAt: [START],
      unsettledName: "nothing",
    },
    { outermost: true },
  )
    .methods(
      Object.fromEntries(
        functions.map((name) => [
          name,
          one.writes.includes(name) ? writes : reads,
        ]),
      ),
      { of: [START] },
    )
    .container(tableOf(model));
}

/** The hooks that read each described library's chains, for a test pack's `invocationRecognizers`. */
export function storageChains(
  described: readonly TestStorage[],
): NonNullable<PythonPack["invocationRecognizers"]> {
  const libraries = [
    ...new Set(described.map((one) => one.module.split(".")[0] ?? one.module)),
  ];
  const matches = described.flatMap((one) => [
    ...(one.types === undefined ? [] : sessionCalls(one, one.types, libraries)),
    ...(one.functions === undefined
      ? []
      : [statementCalls(one, one.functions, libraries)]),
  ]);
  return (
    pack("storage-chains", matches, {
      languages: ["python"],
      recognizedAs: "python-storage",
    }).invocationRecognizers ?? []
  );
}
