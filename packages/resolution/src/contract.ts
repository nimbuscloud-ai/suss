// contract.ts: the cases every language adapter's facts have to satisfy.
// The rules say what a fact means; these say how one has to be keyed, which
// is what an adapter author otherwise reads out of another adapter's source.
// design/proposals/adapter-fact-contract.md says why this exists.

import { NAMED_STORE_NAME } from "./index.js";
import { SPREAD_ENTRY, VALUE_ENTRY } from "./valuePositions.js";

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

/** Whether following `binds` from a key arrives at one of the targets. */
function leadsToOneOf(
  facts: FactsOf,
  key: string,
  targets: ReadonlySet<string>,
): boolean {
  // A set visits what is added to it while it is walked, once each.
  const reached = new Set([key]);
  for (const at of reached) {
    if (targets.has(at)) {
      return true;
    }
    for (const row of facts("binds")) {
      if (row[0] === at && row[1] !== undefined) {
        reached.add(row[1]);
      }
    }
  }
  return false;
}

/** The relations an adapter can use to say a value came from another file. */
const RELATIONS_THAT_CAN_CROSS = ["imports", "binds", "reExports"];

/** Whether a value some function returns, or some collection is given, leads to `key`. */
function someValueLeadsTo(facts: FactsOf, key: string): boolean {
  const target = new Set([key]);
  return ["returnsValue", "holdsUnderKey"].some((relation) =>
    facts(relation).some((row) => leadsToOneOf(facts, row[1] ?? "", target)),
  );
}

/**
 * Whether some container's entries are a value at 0, keyed the way
 * `holdsProperty` keys it under `name`, and then a spread at 1, keyed on
 * the collection it unpacks rather than on the spread itself.
 */
function holdsValueThenSpread(facts: FactsOf, name: string): boolean {
  const entries = facts("writtenEntryAt");
  const held = facts("holdsProperty");
  return [...new Set(entries.map((row) => row[0]))].some((container) => {
    const own = entries.filter((row) => row[0] === container);
    const value = own.find((row) => row[1] === "0");
    const spread = own.find((row) => row[1] === "1");
    return (
      own.length === 2 &&
      value?.[3] === VALUE_ENTRY &&
      spread?.[3] === SPREAD_ENTRY &&
      held.some(
        (row) => row[0] === container && row[1] === name && row[2] === value[2],
      ) &&
      !held.some((row) => row[0] === container && row[2] === spread[2])
    );
  });
}

function valueThenSpread(facts: FactsOf, name: string): string | null {
  if (facts("writtenEntryAt").length === 0) {
    return "no list or object states its entries, so nothing says the order they are written in";
  }
  return holdsValueThenSpread(facts, name)
    ? null
    : `no container's entries are the value under ${name} at 0, keyed as holdsProperty keys it, and then a spread at 1 keyed on the collection it unpacks`;
}

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
    name: "a function calling its parameter",
    requires: "a function whose body calls the parameter it was passed",
    // `bodyCalls` keys a callee the way `call` does, and a factory unwraps
    // when the callee its closure calls is its own parameter.
    check: (facts) => {
      const [fn, call] = facts("makesCall")[0] ?? [];
      if (fn === undefined || call === undefined) {
        return "no function says which calls its body makes, so a call is never placed in the body it is written in";
      }
      const callees = facts("call")
        .filter((row) => row[0] === call)
        .map((row) => row[1]);
      if (callees.length === 0) {
        return "the call a body makes is keyed differently from the call itself, so nothing gives its callee";
      }
      const called = new Set(
        facts("bodyCalls")
          .filter((row) => row[0] === fn)
          .map((row) => row[1]),
      );
      const shared = callees.filter((callee) => called.has(callee));
      if (shared.length === 0) {
        return "bodyCalls keys a callee differently from call, so what a body calls is not followed the way a call's callee is";
      }
      const param = facts("paramOf")[0]?.[2];
      const refersToParam = (callee: string | undefined): boolean =>
        callee === param ||
        facts("binds").some((row) => row[0] === callee && row[1] === param);
      return shared.some(refersToParam)
        ? null
        : "the callee is neither the parameter nor bound to it, so a factory calling its parameter never unwraps";
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
    name: "a class constructed with an argument",
    requires:
      "a module-level class whose constructor takes one parameter, and a site that makes one of it, passing a name",
    // However a language writes construction, it is a call of the class, and
    // the constructor's parameters are the class's. Keying them on the
    // constructor instead leaves the argument with nowhere to land.
    check: (facts) => {
      const classes = new Set(facts("objectValue").map((row) => row[0] ?? ""));
      const parameters = facts("paramOf").filter((row) =>
        classes.has(row[0] ?? ""),
      );
      if (parameters.length === 0) {
        return "a class lists none of its constructor's parameters, so an argument a construction site passes reaches nothing";
      }
      if (facts("call").length === 0) {
        return "making one of a class is not written down as a call, so nothing says which class a construction arrives at";
      }
      return facts("callArg").length > 0
        ? null
        : "a construction passes its argument nowhere, so the parameter it lands in has no value";
    },
  },
  {
    name: "a name declared as a fallback",
    requires:
      "a module-level name declared as a fallback between a property read and a call, `cached || build()` say",
    // The fallback expression states its branches; each branch has to be
    // keyed as the value node itself, or the chain stops at the fallback
    // instead of continuing into whichever branch resolves.
    check: (facts) => {
      const branches = facts("fallbackBranch");
      if (branches.length < 2) {
        return `expected a fallback with two branches, found ${branches.length}`;
      }
      if (distinct(branches.map((row) => row[0] ?? "")) !== 1) {
        return "the two branches are keyed under different expressions, so nothing says they are alternatives for one value";
      }
      const call = facts("call")[0]?.[0];
      if (call === undefined) {
        return "the call branch is not written down as a call, so the branch that resolves has nothing behind it";
      }
      return branches.some((row) => row[1] === call)
        ? null
        : "no branch is the call node itself, so the chain cannot continue into the branch that resolves";
    },
  },
  {
    name: "a class extending another",
    requires:
      "two module-level classes in one file, the second written as extending the first",
    // `extends` has to lead to the base's own node, directly or through the
    // name it is written as, or no rule walking an ancestry finds the base.
    // `extendsNamed` is what a pack matches a library base by.
    check: (facts) => {
      const objects = new Set(facts("objectValue").map((row) => row[0]));
      const bases = facts("extends").filter((row) => objects.has(row[0]));
      if (bases.length === 0) {
        return "no class is written down as extending anything, so a method its base declares is never found on it";
      }
      const leadsToClass = (key: string): boolean =>
        objects.has(key) ||
        facts("binds").some((row) => row[0] === key && objects.has(row[1]));
      if (!bases.some((row) => leadsToClass(row[1] ?? ""))) {
        return "the base is keyed so that nothing leads from it to the class it names";
      }
      const named = facts("extendsNamed").filter((row) =>
        bases.some((base) => base[0] === row[0]),
      );
      return named.length > 0
        ? null
        : "the base's written name is not recorded, so a pack cannot match a library base";
    },
  },
  {
    name: "a property written through a name",
    requires:
      "a module-level name assigned a construction of a class the file declares, and a statement writing a value to a property of that name, `job.retries = 3` say",
    // The rules follow the key a write is stored under to the object it
    // lands on, through `binds`, so the store has to be keyed on the name
    // the way `binds` keys it. Keyed on anything else, it reaches no object.
    check: (facts) => {
      const stores = facts("storesProperty").filter(
        (row) => row[3] === NAMED_STORE_NAME,
      );
      if (stores.length === 0) {
        return "a write through a name is not written down as one, so a later read of that property finds nothing";
      }
      const sites = new Set(facts("call").map((row) => row[0] ?? ""));
      return stores.some((row) => leadsToOneOf(facts, row[0] ?? "", sites))
        ? null
        : "the write is keyed so that nothing leads from it to the construction, so the rules cannot find the object it lands on";
    },
  },
  {
    name: "a table of functions called by a key worked out at run time",
    requires:
      "a module-level table written out with a function under the name created and another under deleted, and a function that calls the table's entry under its parameter, `TABLE[kind](payload)` or the language's own spelling",
    // The rules take the entries off the object the read's container
    // leads to, so the container has to be keyed the way `binds` keys it,
    // and each entry under the name the source writes, without quotes.
    check: (facts) => {
      const entries = facts("holdsProperty");
      const tables = new Set(
        entries
          .filter((row) => row[1] === "created")
          .map((row) => row[0] ?? "")
          .filter((table) =>
            entries.some((row) => row[0] === table && row[1] === "deleted"),
          ),
      );
      if (tables.size === 0) {
        return "no object contains a function under created and another under deleted, written without quotes";
      }
      const reads = facts("choosesEntry");
      if (reads.length === 0) {
        return "the read at a key worked out at run time is not written down as choosesEntry, so no call through it finds the table's functions";
      }
      return reads.some((row) => leadsToOneOf(facts, row[1] ?? "", tables))
        ? null
        : "the read's container is keyed so that nothing leads from it to the table";
    },
  },
  {
    name: "a function written into a table under a computed key",
    requires:
      "a module-level empty table, and a function that writes its second parameter into it under its first, `REGISTRY[name] = handler` or the language's own spelling",
    // A registry fills its table from a function its callers pass handlers
    // to, so the write has to say the parameter went in, keyed so that
    // `binds` leads from where it went to the table.
    check: (facts) => {
      const params = new Set(facts("paramOf").map((row) => row[2] ?? ""));
      const writes = facts("holdsUnderKey").filter((row) =>
        leadsToOneOf(facts, row[1] ?? "", params),
      );
      if (writes.length === 0) {
        return "the write of a parameter into a table under a computed key is not written down as holdsUnderKey";
      }
      const objects = new Set(facts("objectValue").map((row) => row[0] ?? ""));
      return writes.some((row) => leadsToOneOf(facts, row[0] ?? "", objects))
        ? null
        : "the write is keyed so that nothing leads from it to the table";
    },
  },
  {
    name: "a list written with a spread",
    requires:
      "a module-level name assigned a written-out list of a name and then a spread of another name, `[first, ...rest]` or the language's own spelling",
    check: (facts) => valueThenSpread(facts, "0"),
  },
  {
    name: "an object written with a spread",
    requires:
      "a module-level name assigned an object or a dictionary written out with a name under the key a, written as a string where the language writes keys that way, and then a spread of another name",
    check: (facts) => valueThenSpread(facts, "a"),
  },
  {
    name: "a template string with a hole",
    requires:
      "a module-level name assigned the result of a call, and a template string that puts that name between two pieces of text, `/users/${id}/posts` or the language's own spelling",
    check: (facts) => {
      const parts = facts("partAt");
      const [hole, ...moreHoles] = facts("holeAt");
      if (parts.length !== 2 || hole === undefined || moreHoles.length > 0) {
        return `expected two parts and one hole, found ${parts.length} and ${moreHoles.length + (hole === undefined ? 0 : 1)}`;
      }
      const positions = [...parts, hole]
        .filter((row) => row[0] === hole[0])
        .map((row) => row[1])
        .sort();
      if (positions.join() !== "0,1,2" || hole[1] !== "1") {
        return "the parts and the hole of one template are not numbered together in source order from 0";
      }
      const calls = new Set(facts("call").map((row) => row[0] ?? ""));
      return leadsToOneOf(facts, hole[2] ?? "", calls)
        ? null
        : "the hole is keyed so that nothing leads from it to the value the name is given";
    },
  },
  {
    name: "a callback given each element of a list",
    requires:
      "a function that maps its parameter through a callback returning the element it is given, `users.map((user) => user)`, a comprehension or the language's own spelling",
    // The collection is a read of the function's parameter, and the
    // callback's own read of its variable joins the key elementOf states.
    check: (facts) => {
      const [row, ...more] = facts("elementOf");
      if (row === undefined || more.length > 0) {
        return `expected one elementOf row, found ${more.length + (row === undefined ? 0 : 1)}`;
      }
      const params = new Set(facts("paramOf").map((one) => one[2] ?? ""));
      if (!leadsToOneOf(facts, row[1] ?? "", params)) {
        return "the collection is keyed so that nothing leads from it to the parameter it reads";
      }
      return someValueLeadsTo(facts, row[0] ?? "")
        ? null
        : "no read of the variable leads to the key elementOf gives it, so nothing knows what the read is given";
    },
  },
  {
    name: "a callback given each position in a list",
    requires:
      "a function that maps its parameter through a callback taking the element and then its position and returning the position, `users.map((user, at) => at)`, `enumerate` in a comprehension, or the language's own spelling",
    check: (facts) => {
      const [row, ...more] = facts("positionOf");
      if (row === undefined || more.length > 0) {
        return `expected one positionOf row, found ${more.length + (row === undefined ? 0 : 1)}`;
      }
      if (!facts("elementOf").some((one) => one[0] === row[1])) {
        return "the position is tied to a variable that no elementOf row gives an element, so nothing says what it counts through";
      }
      return someValueLeadsTo(facts, row[0] ?? "")
        ? null
        : "no read of the position leads to the key positionOf gives it";
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
