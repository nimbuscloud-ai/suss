// contract.ts: the cases every language adapter's facts have to satisfy.
// The rules say what a fact means; these say how one has to be keyed, which
// is what an adapter author otherwise reads out of another adapter's source.
// docs/internal/proposals/adapter-fact-contract.md says why this exists.

import type { Database } from "@suss/datalog";

/** The tuples of one relation, as strings, which is all a case compares. */
export type FactsOf = (relation: string) => string[][];

export interface ContractCase {
  /** The key an adapter supplies its own source under. */
  readonly name: string;
  /** What that source has to contain, for whoever writes it. */
  readonly requires: string;
  /**
   * Null when the facts satisfy the case; otherwise what is wrong with them.
   * `files` is the source file names the adapter supplied, so a case about a
   * value leaving its file can say which file it should have left.
   */
  readonly check: (facts: FactsOf, files: readonly string[]) => string | null;
}

const distinct = (values: string[]): number => new Set(values).size;

/** The relations an adapter can use to say a value came from another file. */
const RELATIONS_THAT_CAN_CROSS = ["imports", "binds", "reExports"];

export const FACT_CONTRACT_CASES: readonly ContractCase[] = [
  {
    name: "two functions, one parameter name",
    requires:
      "two functions in one file, each declaring a parameter of the same name",
    check: (facts) => {
      const params = facts("paramOf").map((row) => row[2] ?? "");
      if (params.length < 2) {
        return `expected two parameters, found ${params.length}`;
      }
      return distinct(params) === params.length
        ? null
        : "two parameters share a key, so a value is keyed by its name rather than by the node that declares it";
    },
  },
  {
    name: "a name read inside a function",
    requires:
      "a function with a parameter, whose body reads that parameter and returns it",
    // An adapter may key the read as the parameter itself, or as its own
    // node linked by `binds`. Both join; what fails is a read that reaches
    // its declaration by neither.
    check: (facts) => {
      const param = facts("paramOf")[0]?.[2];
      const returned = facts("returnsValue")[0]?.[1];
      if (param === undefined || returned === undefined) {
        return "expected one parameter and one return";
      }
      if (param === returned) {
        return null;
      }
      const linked = facts("binds").some(
        (row) => row[0] === returned && row[1] === param,
      );
      return linked
        ? null
        : "a read of a parameter is neither the parameter nor bound to it, so a read and its declaration never join";
    },
  },
  {
    name: "a name bound to a call",
    requires: "a module-level name assigned the result of a call",
    check: (facts) => {
      const call = facts("call")[0]?.[0];
      if (call === undefined) {
        return "expected one call";
      }
      const written = facts("writtenValue").some((row) => row[0] === call);
      if (!written) {
        return "a call is not a written value, so a chain ending at one derives nothing through isWrittenAs";
      }
      return facts("comesTo").some((row) => row[0] === call)
        ? "a call has a comesTo, which the rules withhold on purpose so a factory call does not answer with what it returns"
        : null;
    },
  },
  {
    name: "a written-out sequence",
    requires: "a module-level name assigned a written-out list of two names",
    check: (facts) => {
      if (facts("objectValue").length === 0) {
        return "a sequence is not an object value, so nothing can be read out of it";
      }
      const keys = facts("holdsProperty").map((row) => row[1] ?? "");
      if (keys.length < 2) {
        return `a sequence keeps no elements: expected two, found ${keys.length}`;
      }
      return keys.includes("0") && keys.includes("1")
        ? null
        : `a sequence keeps its elements under ${JSON.stringify(keys)} rather than their positions, so one property rule cannot cover indexed access`;
    },
  },
  {
    name: "a module exporting a name",
    requires: "a module-level function declaration",
    check: (facts) => {
      const exported = facts("exportsAs")[0];
      if (exported === undefined) {
        return "a module exports nothing, so no other file can reach into it";
      }
      const value = exported[2] ?? "";
      return facts("func").some((row) => row[0] === value)
        ? null
        : "what a module exports is not the node that declares it";
    },
  },
  {
    name: "a class declaring a method",
    requires:
      "a module-level class with one method, exported where a language says so",
    check: (facts) => {
      const objects = new Set(facts("objectValue").map((row) => row[0]));
      if (objects.size === 0) {
        return "a class is not an object value, so nothing can be read off an instance of it";
      }
      const functions = new Set(facts("func").map((row) => row[0]));
      const contained = facts("holdsProperty").filter((row) =>
        objects.has(row[0]),
      );
      if (contained.length === 0) {
        return "a class contains none of its methods, so a method read off an instance resolves to nothing";
      }
      return contained.some((row) => functions.has(row[2]))
        ? null
        : "what a class contains under a method name is not the node that declares the method";
    },
  },
  {
    name: "a value another file declares",
    requires:
      "two files, one declaring a value and the other reading it by name",
    // Which relation says so is the language's business. TypeScript and Python
    // both write an import; Ruby has none and binds the reading site straight
    // to the definition. What has to be true is that some fact reaches out of
    // the file doing the reading into the file doing the declaring.
    check: (facts, files) => {
      if (files.length < 2) {
        return "expected two files";
      }
      const mentions = (value: string, file: string): boolean =>
        value.includes(file);
      const crosses = RELATIONS_THAT_CAN_CROSS.some((relation) =>
        facts(relation).some((row) =>
          files.some(
            (from) =>
              mentions(row[0] ?? "", from) &&
              row
                .slice(1)
                .some((cell) =>
                  files.some((to) => to !== from && mentions(cell, to)),
                ),
          ),
        ),
      );
      return crosses
        ? null
        : "nothing links a name read in one file to what another file declares, so a value cannot leave the file it is written in";
    },
  },
];

/** One case's source, as the files it takes, because a value leaving its file takes two. */
export type CaseFiles = Readonly<Record<string, string>>;

export interface ContractOptions {
  /**
   * Cases the adapter is known not to satisfy, each with why. A known case
   * that starts passing is reported too, so a gap that gets closed does not
   * stay written down as one.
   */
  readonly known?: Readonly<Record<string, string>>;
}

/**
 * Every case an adapter fails, with what is wrong. Empty when the adapter
 * satisfies the contract. `emit` reads the files a case supplies and gives
 * back the facts the adapter produced for them.
 */
export function checkFactContract(
  sources: Readonly<Record<string, CaseFiles>>,
  emit: (files: CaseFiles) => Promise<Database> | Database,
  options: ContractOptions = {},
): Promise<{ case: string; problem: string }[]> {
  return FACT_CONTRACT_CASES.reduce<
    Promise<{ case: string; problem: string }[]>
  >(async (soFar, contractCase) => {
    const failures = await soFar;
    const files = sources[contractCase.name];
    if (files === undefined) {
      return [
        ...failures,
        {
          case: contractCase.name,
          problem: `no source supplied for: ${contractCase.requires}`,
        },
      ];
    }

    const db = await emit(files);
    const problem = contractCase.check(
      (relation) => db.facts(relation).map((row) => row.map(String)),
      Object.keys(files),
    );
    const known = options.known?.[contractCase.name];
    if (known !== undefined) {
      return problem === null
        ? [
            ...failures,
            {
              case: contractCase.name,
              problem: `written down as a known gap (${known}) and now satisfied, so take it off the list`,
            },
          ]
        : failures;
    }
    return problem === null
      ? failures
      : [...failures, { case: contractCase.name, problem }];
  }, Promise.resolve([]));
}
