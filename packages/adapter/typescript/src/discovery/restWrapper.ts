/**
 * restWrapper.ts: a project function that hands its own parameter to an
 * HTTP client call, read as one request per caller.
 *
 * The wrapper's path and method are built out of its parameters, so the
 * library call read where it is written leaves a hole. The store says
 * which calls fill each parameter, and the call is read again with the
 * parameters bound to what each caller passes. A caller whose own
 * arguments are parameters is a wrapper in turn, and the round repeats
 * outward until something states a path. A caller that passes the
 * method keeps it when nothing further out states a path. The README in
 * `facts/` says how the call sites are found and what reading costs.
 */

import { Node } from "ts-morph";

import { hole } from "@suss/values";

import { argumentsAt, evaluatedValueUnder } from "../values/evaluator.js";
import { enclosingFunctionRoot } from "./graphqlShared.js";

import type { Value } from "@suss/values";
import type { CallExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * How many wrappers deep an expansion follows, matching the GraphQL
 * side: a service method over a verb over the request layer is three,
 * which is as far as a generated client layers.
 */
const MAX_WRAPPER_DEPTH = 3;

/** The request a wrapper's library call states once its holes are filled. */
export interface SinkReading {
  /** Null when the caller passes the method and nothing settles where the request goes. */
  path: string | null;
  method: string;
  /** The host when the URL the caller settles is absolute. */
  host?: string;
}

/**
 * The wrapper's library call, read with some of the wrapper's own
 * parameters bound. Null when what comes out states neither a path nor
 * a method the caller passed.
 */
export type ReadSink = (
  bindings: ReadonlyMap<string, Value>,
) => SinkReading | null;

/** One caller whose values settled the wrapper's request. */
export interface WrapperCaller {
  caller: FunctionRoot;
  /** The call inside the caller, which is where its response is read. */
  call: CallExpression;
  reading: SinkReading;
}

/**
 * Every caller that grounds the request `readSink` describes, however
 * many of the project's own functions stand between it and the library.
 */
export function expandRestWrapperCallers(
  wrapper: FunctionRoot,
  readSink: ReadSink,
  store: ResolutionStore,
): WrapperCaller[] {
  return expandFrom(
    wrapper,
    (bindings) => bindings,
    readSink,
    store,
    0,
    new Set([wrapper]),
  );
}

/**
 * Values for the innermost wrapper's parameters, given values for the
 * parameters of the function being expanded now. Each round out wraps
 * the one before it, so the library call is evaluated under whatever
 * the outermost caller wrote.
 */
type ToSinkBindings = (
  forFunction: ReadonlyMap<string, Value>,
) => ReadonlyMap<string, Value>;

/**
 * Each parameter standing for itself. Binding them keeps a name the
 * store settled from one caller's literal out of the reading, so a
 * wrapper called once expands the same way as one called twice.
 */
export function parametersAsHoles(
  func: FunctionRoot,
): ReadonlyMap<string, Value> {
  const bindings = new Map<string, Value>();
  for (const parameter of func.getParameters()) {
    const nameNode = parameter.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      bindings.set(nameNode.getText(), hole(nameNode.getText()));
    }
  }
  return bindings;
}

function expandFrom(
  func: FunctionRoot,
  toSink: ToSinkBindings,
  readSink: ReadSink,
  store: ResolutionStore,
  depth: number,
  expanded: ReadonlySet<FunctionRoot>,
): WrapperCaller[] {
  const out: WrapperCaller[] = [];
  for (const site of callSitesOf(func, store)) {
    const caller = enclosingFunctionRoot(site.call);
    if (caller === null) {
      continue;
    }
    const reading = readSink(
      toSink(valuesAt(site, parametersAsHoles(caller), store)),
    );
    if (reading !== null && reading.path !== null) {
      out.push({ caller, call: site.call, reading });
      continue;
    }
    const further =
      depth + 1 >= MAX_WRAPPER_DEPTH || expanded.has(caller)
        ? []
        : expandFrom(
            caller,
            (forCaller) => toSink(valuesAt(site, forCaller, store)),
            readSink,
            store,
            depth + 1,
            new Set([...expanded, caller]),
          );
    out.push(...handedOutward({ caller, call: site.call, reading }, further));
  }
  return out;
}

/**
 * What a caller that settles no path leaves to the callers further out.
 * One that passes the method makes the request its own: the callers out
 * there that settle a path keep theirs, and when none does, this caller
 * keeps its method with no path.
 */
function handedOutward(
  here: Omit<WrapperCaller, "reading"> & { reading: SinkReading | null },
  further: readonly WrapperCaller[],
): WrapperCaller[] {
  const { reading } = here;
  if (reading === null) {
    return [...further];
  }
  const grounded = further.filter((found) => found.reading.path !== null);
  return grounded.length > 0 ? grounded : [{ ...here, reading }];
}

interface CallSite {
  call: CallExpression;
  /** What each of the called function's parameters was given here. */
  arguments: Map<string, Node>;
}

/**
 * Every call of `func`, with the argument written at each parameter. A
 * parameter written as a pattern rather than a name is skipped, since
 * the evaluator binds by name and a pattern has none.
 */
function callSitesOf(func: FunctionRoot, store: ResolutionStore): CallSite[] {
  const byCall = new Map<string, CallSite>();
  for (const parameter of func.getParameters()) {
    const nameNode = parameter.getNameNode();
    if (!Node.isIdentifier(nameNode)) {
      continue;
    }
    for (const passed of store.argumentsPassedTo(parameter)) {
      if (!Node.isCallExpression(passed.call)) {
        continue;
      }
      const key = siteKey(passed.call);
      const site = byCall.get(key) ?? {
        call: passed.call,
        arguments: new Map<string, Node>(),
      };
      byCall.set(key, site);
      site.arguments.set(nameNode.getText(), passed.argument);
    }
  }
  return [...byCall.values()];
}

function siteKey(call: CallExpression): string {
  return `${call.getSourceFile().getFilePath()}:${call.getStart()}`;
}

/**
 * What the call gives each of the wrapper's parameters. A parameter the
 * call leaves out takes its default or undefined, as it does when the
 * call runs. Left unbound, it would read as whatever another caller
 * passed there.
 */
function valuesAt(
  site: CallSite,
  bindings: ReadonlyMap<string, Value>,
  store: ResolutionStore,
): ReadonlyMap<string, Value> {
  const bound = argumentsAt(site.call, store, bindings);
  // The evaluator binds the function it resolves the call to, which is
  // the wrapper when it binds every parameter the store found filled.
  if (bound !== null && [...site.arguments.keys()].every((n) => bound.has(n))) {
    return bound;
  }
  const values = new Map<string, Value>();
  for (const [name, argument] of site.arguments) {
    values.set(name, evaluatedValueUnder(argument, store, bindings));
  }
  return values;
}
