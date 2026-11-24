/**
 * What this adapter hands the ops in `@suss/recognize/ops`, so a pack
 * declared with `@suss/recognize` runs over Ruby the way it runs over
 * TypeScript and Python. Ruby states every fact before discovery, so
 * nothing is read on demand.
 *
 * Three readings are Ruby's own. A call's callee is keyed on the method's
 * name, so its text is the receiver and the name as written. A class's own
 * method is stated under a spelling of its own, which the ops read back as
 * the plain name. And a value comes from a library when the constant it
 * reads is one the facts state as imported from the global module, under
 * a path that starts with the library's own constant.
 */

import { referenceName } from "@suss/behavioral-ir";
import {
  answersFor,
  classBodyCalls,
  classMemberOf,
  environmentsReaching,
  GLOBAL_MODULE,
  givenBackFunction,
  handedNamesReaching,
  noteKeyRead,
} from "@suss/resolution";
import {
  concat,
  hostOf,
  literalOf as literalOfValue,
  pathOf,
  scalarOf,
  text,
} from "@suss/values";

import {
  children,
  field,
  numberLiteralValue,
  pairValue,
  rangeOf,
  stringLiteralValue,
} from "./ast.js";
import { declaredName, filesDeclaring } from "./baseClass.js";
import { decodedIn, encodedIn } from "./encoded.js";
import { copingAt, keysSuppliedAt } from "./envReads.js";
import { CONSTRUCTOR } from "./facts/languageWords.js";
import { parametersOf, paramNameOf } from "./facts/locals.js";
import {
  anchorCallsOf,
  RUBY_PROGRAM,
  resolvedFunctions,
  resolveStreamObjects,
  resolveValues,
  writtenValueOf,
  writtenValueUnder,
} from "./facts/resolve.js";
import { writtenArgument } from "./facts/values.js";
import { argOf } from "./paths/effects.js";
import { noteClassesInRun } from "./reuse.js";
import {
  constructionSitesOf,
  evaluatedValue,
  forksAt,
  nodeOfResolutionKey,
  type ParameterBindings,
} from "./values/evaluator.js";
import { writtenShapeOf } from "./writtenShape.js";

import type { Database } from "@suss/datalog";
import type {
  EffectArg,
  FactSource,
  ValueAt,
  ValueForm,
} from "@suss/extractor";
import type { Value } from "@suss/values";
import type { EncodedNode } from "./encoded.js";
import type { RbNode } from "./parser.js";

/** A fact source with the run's whole database, which the rules this adapter asks read. */
export type RubyFactSource = FactSource & { readonly db: Database };

const sources = new WeakMap<Database, RubyFactSource>();

/** The one fact source for a run's database, for a reader that asks at every site of every body. */
export function factSourceOf(db: Database): RubyFactSource {
  let source = sources.get(db);
  if (source === undefined) {
    source = rubyFactSource(db);
    sources.set(db, source);
  }
  return source;
}

/**
 * The fact source for one run's database. With arms, every value it
 * evaluates takes them, as `CallOps.takingArms` reads a call.
 */
export function rubyFactSource(
  db: Database,
  arms?: ReadonlyMap<string, number>,
): RubyFactSource {
  const nodeAt = (key: string | null): RbNode | null =>
    key === null ? null : nodeOfResolutionKey(key, db);
  const evaluated = (
    node: RbNode,
    bindings?: ParameterBindings,
    site?: string,
  ): Value => evaluatedValue(node, db, bindings, site, arms);
  // A name has no node, so its value is what it was written as.
  const valueNode = (key: string): RbNode | null =>
    nodeAt(key) ?? nodeAt(writtenValueOf(db, key));
  // The argument as the call writes it, so a name is read at the
  // assignment that reaches the call. The call can be a construction in
  // another file, whose syntax a cached run then depends on.
  const writtenNode = (value: ValueAt): RbNode | null => {
    const call = value.at === undefined ? null : nodeAt(value.at.call);
    if (call !== null && value.at !== undefined) {
      noteKeyRead(db, value.at.call);
    }
    const argument =
      call === null || value.at === undefined
        ? null
        : writtenArgument(call, value.at.at);
    return argument ?? valueNode(value.key);
  };
  const evaluatedAt = (value: ValueAt, site: string | undefined) => {
    const node = writtenNode(value);
    return node === null ? null : evaluated(node, undefined, site);
  };
  const textOf = (key: string): string => {
    const node = nodeAt(key);
    return node === null ? nameIn(key) : calleeText(node);
  };

  return {
    db,
    read: () => undefined,
    writtenAs: (key) => writtenValueOf(db, key),
    writtenUnder: (key, site) => writtenValueUnder(db, key, site),
    anchorCalls: (key) => anchorCallsOf(db, key),
    importedFrom: (key, module) =>
      libraryPathsOf(db, key).some(
        (path) => pathInModule(path, module) !== null,
      ),
    importedAs: (key, module) =>
      libraryPathsOf(db, key).flatMap((path) => {
        const inside = pathInModule(path, module);
        return inside === null ? [] : [inside];
      }),
    importedUnder: (key, modules) =>
      importedPathsOf(db, key).flatMap((path) =>
        modules.flatMap((module) => {
          const inside = pathInModule(path, module);
          return inside === null ? [] : [inside];
        }),
      ),
    shapeOf: (key) => shapeOf(nodeAt(key)),
    memberName: (stated) => classMemberOf(stated) ?? stated,
    readsMembersAsCalls: true,
    constructedClass: (callee) => constructedClass(nodeAt(callee)),
    textOf,
    lineOf: (key) => {
      const node = nodeAt(key);
      return node === null ? null : rangeOf(node).start;
    },
    writtenItemsOf: (key) => writtenItemsOf(nodeAt(key)),
    formOf: (key) => formOf(nodeAt(key)),
    constantPathOf: (key, at) => {
      const call = at === undefined ? null : nodeAt(at.call);
      const node =
        call === null || at === undefined
          ? nodeAt(key)
          : writtenArgument(call, at.at);
      return node !== null && CONSTANT_TYPES.has(node.type) ? node.text : null;
    },
    literalOf: (key) => literalOf(nodeAt(key)),
    writesNothing: (key) => nodeAt(key)?.type === "nil",
    nameOf: (key, unsettled) => {
      const node = valueNode(key);
      const settled = node === null ? null : literalOfValue(evaluated(node));
      if (settled !== null || unsettled !== "reference") {
        return settled;
      }
      return nodeAt(key) === null
        ? referenceName({ root: nameIn(key), fields: [] })
        : null;
    },
    argOf: (key): EffectArg => {
      const node = valueNode(key);
      return node === null
        ? { kind: "identifier", name: nameIn(key) }
        : argOf(node, db);
    },
    encodedOf: (key) => keyedCodec(db, key, nodeAt(key), encodedIn),
    decodedOf: (key) => keyedCodec(db, key, nodeAt(key), decodedIn),
    typeShapeOf: (key) => {
      const node = nodeAt(key);
      return node === null ? { type: "unknown" } : writtenShapeOf(node);
    },
    spellsGlobal: (key, path) => globalPathOf(db, key, nodeAt(key)) === path,
    // A class that defines its own `warn` runs that method on a bare call.
    callsGlobal: (call, path) => {
      const node = nodeAt(call);
      return (
        node?.type === "call" &&
        node.childForFieldName("receiver") === null &&
        node.childForFieldName("method")?.text === path &&
        !runsProjectMethod(db, call)
      );
    },
    globalsReaching: (key) => {
      resolveStreamObjects(
        db,
        db.facts("streamObject").map((row) => String(row[0])),
      );
      return db.lookup("wantedStreamValue", 0, key).flatMap((row) => {
        const object = String(row[1]);
        const path = globalPathOf(db, object, nodeAt(object));
        return path === null ? [] : [path];
      });
    },
    handedReaching: (key) => handedNamesReaching(db, key, RUBY_PROGRAM),
    evaluatedOf: (key) => {
      const node = valueNode(key);
      return node === null ? null : scalarOf(evaluated(node));
    },
    evaluatedWith: (key, bindings) => {
      const node = valueNode(key);
      return node === null ? null : scalarOf(evaluated(node, bindings));
    },
    urlOf: (key, site, at) => {
      const value = evaluatedAt({ key, at }, site);
      return value === null
        ? null
        : { path: pathOf(value), host: hostOf(value) };
    },
    hostOf: (host, port, site) => {
      const hostValue = evaluatedAt(host, site);
      if (hostValue === null) {
        return undefined;
      }
      const portNode = port === null ? null : writtenNode(port);
      return hostWithPort(
        hostValue,
        portNode === null || portNode.type === "nil"
          ? null
          : evaluated(portNode, undefined, site),
      );
    },
    isStringOf: (key, site, at) =>
      evaluatedAt({ key, at }, site)?.kind === "string",
    constructionSitesOf: (call) => {
      const node = nodeAt(call);
      return node === null ? [] : constructionSitesOf(node, db);
    },
    forksOf: (call) => {
      const node = nodeAt(call);
      return node === null
        ? null
        : forksAt(callArgumentNodes(node), db, arms ?? new Map());
    },
    takingArms: (taken) => rubyFactSource(db, taken),
    comesTo: (key) => {
      resolveValues(db, [key]);
      return answersFor(db, "wantedComesTo", key);
    },
    classBodyCalls: (key) =>
      classBodyCalls(db, [key], RUBY_PROGRAM).get(key) ?? [],
    spellsBase: (written, spec) => {
      const path = written.startsWith("::") ? written.slice(2) : written;
      return spec.from.some((module) =>
        spec.named.some((name) => path === `${module}::${name}`),
      );
    },
    otherDeclarationsOf: (key) => otherDeclarationsOf(db, key),
    givesBack: (key) => {
      resolveValues(db, [key]);
      return givenBackFunction(db, key);
    },
    // A Ruby file requires another file and imports no names, so no
    // value has a specifier.
    importSpecifierOf: () => null,
    parameterOf: (key) => blockVariableOf(db, key),
    // The node is found only when a pack asks for it, since the declared
    // hooks make the ops for every value they read.
    extendValue: (key, ops) => Object.assign(ops, { ast: () => nodeAt(key) }),
    defaultedAt: (key) => {
      const node = nodeAt(key);
      return node !== null && copingAt(node, factSourceOf(db)).defaulted;
    },
    fallbackOf: (key) => {
      const node = nodeAt(key);
      return node === null ? null : copingAt(node, factSourceOf(db)).fallback;
    },
    keysSupplied: (call) => keysSuppliedAt(factSourceOf(db), call),
    runtimePathOf: (key, object) => {
      if (object.origin !== "global") {
        return undefined;
      }
      const listed = (value: string): boolean =>
        object.paths.includes(globalPathOf(db, value, nodeAt(value)) ?? "");
      const spelled = globalPathOf(db, key, nodeAt(key));
      if (spelled !== null && listed(key)) {
        return spelled;
      }
      return environmentsReaching(db, key, RUBY_PROGRAM).some(listed)
        ? object.paths[0]
        : undefined;
    },
  };
}

/**
 * The block a block variable belongs to, and its place among the block's
 * parameters. A block variable is keyed `<block node>#<name>`, and the
 * facts state no `paramOf` row for it.
 */
function blockVariableOf(
  db: Database,
  key: string,
): { func: string; position: number } | null {
  const split = key.lastIndexOf("#");
  const block = split < 0 ? null : key.slice(0, split);
  if (block === null || db.lookup("callBlock", 1, block).length === 0) {
    return null;
  }
  const node = nodeOfResolutionKey(block, db);
  const name = nameIn(key);
  const position =
    node === null
      ? -1
      : parametersOf(node).findIndex(
          (param) => paramNameOf(param)?.text === name,
        );
  return position < 0 ? null : { func: block, position };
}

/**
 * The other bodies the run writes for the class at the key, by its full
 * name. A cached run charges each one's file, and looks again once a
 * file that reopens the class joins.
 */
function otherDeclarationsOf(db: Database, key: string): string[] {
  const name = declaredName(db, key);
  if (name === undefined) {
    return [];
  }
  noteClassesInRun(db, name, filesDeclaring(db, name));
  const others = db
    .lookup("rbConstantName", 1, name)
    .map((row) => String(row[0]))
    .filter((other) => other !== key);
  for (const other of others) {
    noteKeyRead(db, other);
  }
  return others;
}

/** What an encoder or a decoder call at the key was handed, as the facts key it, and the encoding. */
function keyedCodec(
  db: Database,
  key: string,
  call: RbNode | null,
  handed: (call: RbNode) => EncodedNode | null,
): { codec: string; value: string } | null {
  const found = call === null ? null : handed(call);
  const value = found === null ? null : keyOfEncoded(db, key, found.at);
  return found === null || value === null
    ? null
    : { codec: found.codec, value };
}

/** Whether some function the project wrote is what the call at the key runs. */
function runsProjectMethod(db: Database, call: string): boolean {
  const callees = db.lookup("call", 0, call).map((row) => String(row[1]));
  resolveValues(db, callees);
  return callees.some((callee) => resolvedFunctions(db, callee).length > 0);
}

/** The key the facts give the value an encoder call encodes: its receiver, or one of its arguments. */
function keyOfEncoded(
  db: Database,
  call: string,
  at: EncodedNode["at"],
): string | null {
  if (at === "receiver") {
    const [callee] = db.lookup("call", 0, call);
    const [read] =
      callee === undefined
        ? []
        : db.lookup("readsProperty", 0, String(callee[1]));
    return read === undefined ? null : String(read[1]);
  }
  const argument = db
    .lookup("callArg", 0, call)
    .find((row) => String(row[1]) === String(at));
  return argument === undefined ? null : String(argument[2]);
}

/** How Ruby writes a constant, `Order`, and a constant path, `Billing::Order`. */
const CONSTANT_TYPES = new Set(["constant", "scope_resolution"]);

const FORMS: Record<string, ValueForm> = {
  block: "function",
  do_block: "function",
  lambda: "function",
  identifier: "name",
  simple_symbol: "name",
  hash: "object",
};

/** How the source wrote a value. A local or a parameter is keyed as a name, with no node. */
function formOf(node: RbNode | null): ValueForm {
  return node === null ? "name" : (FORMS[node.type] ?? "other");
}

/** A method's name with the receiver it is sent to, `cache.get`, which is how Ruby writes a callee. */
function calleeText(node: RbNode): string {
  const parent = node.parent;
  const receiver =
    parent === null ? null : (SENT_TO[parent.type]?.(parent, node) ?? null);
  return receiver === null ? node.text : `${receiver.text}.${node.text}`;
}

/** What a method's name is sent to, by the node it is the name of: `cache` in `cache.get`, `out` in `out << line`. */
const SENT_TO: Partial<
  Record<string, (parent: RbNode, method: RbNode) => RbNode | null>
> = {
  call: (call, method) =>
    call.childForFieldName("method") === method
      ? call.childForFieldName("receiver")
      : null,
  binary: (binary, operator) =>
    binary.childForFieldName("operator") === operator
      ? binary.childForFieldName("left")
      : null,
};

/** The class `Klass.new` makes, by its own name: `Connection` for `PG::Connection.new`. */
function constructedClass(method: RbNode | null): string | null {
  const call = method?.parent;
  if (
    method === null ||
    method === undefined ||
    method.text !== CONSTRUCTOR ||
    call?.type !== "call" ||
    call.childForFieldName("method") !== method
  ) {
    return null;
  }
  const receiver = call.childForFieldName("receiver");
  const named =
    receiver?.type === "scope_resolution"
      ? receiver.childForFieldName("name")
      : receiver;
  return named?.type === "constant" ? named.text : null;
}

/**
 * The global a value is spelled as: a `$` variable by its name, or a
 * constant no file in the run defines, such as `STDOUT`, by its path.
 */
function globalPathOf(
  db: Database,
  key: string,
  node: RbNode | null,
): string | null {
  if (node?.type === "global_variable") {
    return node.text;
  }
  const [only, ...more] = libraryPathsOf(db, key);
  return only === undefined || more.length > 0 ? null : only;
}

/**
 * The constant paths the value at this key reads, as a file's own import
 * statements would say: the paths no file in the run defines, and the
 * path of a class or module the project defines. Ruby reopens a class
 * written again, so a project that writes `class Net::HTTP` to add a
 * method still sends its requests through the library's class.
 */
function importedPathsOf(db: Database, key: string): string[] {
  const bound = db.lookup("binds", 0, key).map((row) => String(row[1]));
  return [
    ...[key, ...bound].flatMap((one) => libraryPathsOf(db, one)),
    ...bound.flatMap((one) =>
      db.lookup("rbConstantName", 0, one).map((row) => String(row[1])),
    ),
  ];
}

/** The constant paths a library defines that the value at this key reads. */
function libraryPathsOf(db: Database, key: string): string[] {
  return db
    .lookup("imports", 0, key)
    .filter((row) => row[1] === GLOBAL_MODULE)
    .map((row) => String(row[2]));
}

/**
 * Where a constant path is inside the library's own constant: `*` for
 * the constant itself, `Client` for `Aws::SQS::Client` inside `Aws::SQS`,
 * and null for a path outside it.
 */
function pathInModule(path: string, module: string): string | null {
  if (path === module) {
    return "*";
  }
  return path.startsWith(`${module}::`) ? path.slice(module.length + 2) : null;
}

const SHAPES: Record<string, "object" | "list"> = {
  hash: "object",
  array: "list",
  string_array: "list",
  symbol_array: "list",
};

function shapeOf(node: RbNode | null): "object" | "list" | null {
  return node === null ? null : (SHAPES[node.type] ?? null);
}

/** Each item of an array written out at this node, `%w[]` and `%i[]` included, as written. */
function writtenItemsOf(node: RbNode | null): string[] | null {
  if (node === null || SHAPES[node.type] !== "list") {
    return null;
  }
  return node.namedChildren
    .filter((child) => child.type !== "comment")
    .map((child) => child.text);
}

/** A string, number or boolean the source writes out at this node, read as written. */
function literalOf(node: RbNode | null): string | number | boolean | null {
  if (node === null) {
    return null;
  }
  if (node.type === "true" || node.type === "false") {
    return node.type === "true";
  }
  return stringLiteralValue(node) ?? numberLiteralValue(node);
}

/** The name at the end of a name key. */
function nameIn(key: string): string {
  return key.slice(key.lastIndexOf("#") + 1);
}

/** The values a call passes, a keyword argument's value in place of its pair. */
function callArgumentNodes(call: RbNode): RbNode[] {
  const args = call.type === "call" ? field(call, "arguments") : null;
  return children(args).flatMap((argument) => {
    const value = argument.type === "pair" ? pairValue(argument) : argument;
    return value === null ? [] : [value];
  });
}

/**
 * A host a call takes as an argument of its own, with the port after it,
 * written the way `hostOf` writes the host of `http://host:port`.
 * Net::HTTP sends to that URL until a project turns TLS on, so a port of
 * 80 is left out and any other port is kept.
 */
function hostWithPort(host: Value, port: Value | null): string | undefined {
  return hostOf(
    concat([
      text("http://"),
      host,
      ...(port === null ? [] : [text(":"), port]),
    ]),
  );
}
