/**
 * restWrapper.ts: a project function that hands its own parameter to an
 * HTTP client call, read as one request per caller.
 *
 * The wrapper states no boundary of its own. Its path and its method
 * are built out of a parameter, so evaluating the library call's
 * argument where it is written leaves a hole where the request should
 * be. The callers come from the facts: the store says which calls
 * filled the parameter and what each wrote there, and the evaluator is
 * asked again with the parameter bound to that. A caller whose own
 * arguments are parameters too is a wrapper in turn, and the round
 * repeats outward until something states a path. The README in `facts/`
 * says how the call sites are found and what reading them costs.
 */

import { Node } from "ts-morph";

import { hole } from "@suss/values";

import { evaluatedValueUnder } from "../values/evaluator.js";
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
  path: string;
  method: string;
}

/**
 * The wrapper's library call, read with some of the wrapper's own
 * parameters bound. Null when what comes out still states no path.
 */
export type ReadSink = (
  bindings: ReadonlyMap<string, Value>,
) => SinkReading | null;

/** One caller whose literals settled the wrapper's request. */
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
    if (reading !== null) {
      out.push({ caller, call: site.call, reading });
      continue;
    }
    if (depth + 1 >= MAX_WRAPPER_DEPTH || expanded.has(caller)) {
      continue;
    }
    out.push(
      ...expandFrom(
        caller,
        (forCaller) => toSink(valuesAt(site, forCaller, store)),
        readSink,
        store,
        depth + 1,
        new Set([...expanded, caller]),
      ),
    );
  }
  return out;
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

function valuesAt(
  site: CallSite,
  bindings: ReadonlyMap<string, Value>,
  store: ResolutionStore,
): ReadonlyMap<string, Value> {
  const values = new Map<string, Value>();
  for (const [name, argument] of site.arguments) {
    values.set(name, evaluatedValueUnder(argument, store, bindings));
  }
  return values;
}
