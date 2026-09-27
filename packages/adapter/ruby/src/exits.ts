/**
 * Where a Ruby body ends the process: `exit`, `exit!` and `abort` written
 * with no receiver, or on `Kernel`. Each is an `exit` terminal with the
 * code it hands over, the way the Node pack reads `process.exit`. `exit`
 * with no code exits 0 and `exit false` exits 1, `exit!` with none exits
 * 1, and `abort` always exits 1 after printing its message. These are
 * Ruby's own `Kernel` methods, so the adapter reads them without a pack.
 *
 * A reached method has one transition, since nothing tells its paths
 * apart. One that ends the process has its paths read one by one
 * instead, so each exit is a transition with the conditions that lead
 * to it.
 */

import {
  markReturnsAsExitCode,
  SKIP_CHILDREN,
  walkDescendants,
} from "@suss/extractor";
import { exitCodeFunctions } from "@suss/resolution";
import { constantOf } from "@suss/values";

import { field, rangeOf, readCallArgs } from "./ast.js";
import { nodeId } from "./facts/values.js";
import { returnPathBranches } from "./responseStatus.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, RawEffect, RawTerminal } from "@suss/extractor";
import type { RbNode } from "./parser.js";
import type { EndingCall } from "./responseStatus.js";

/** The code each Kernel method exits with when it is handed none. */
const EXIT_METHODS: Readonly<Record<string, number>> = {
  exit: 0,
  "exit!": 1,
  abort: 1,
};

/** A method or a block ends the process when it runs, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/** One call that ends the process, and the value it hands over, if any. */
export interface ExitSite {
  call: RbNode;
  method: string;
  code: RbNode | null;
}

/** Every call under `root` that ends the process, `root` itself left out. */
export function exitSites(root: RbNode): ExitSite[] {
  const found: ExitSite[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const site = node.type === "call" ? exitSiteAt(node) : null;
      if (site !== null) {
        found.push(site);
      }
    },
    into: (node) => (DEFERRED_BODY_TYPES.has(node.type) ? SKIP_CHILDREN : null),
  });
  return found;
}

function exitSiteAt(call: RbNode): ExitSite | null {
  const method = field(call, "method")?.text ?? "";
  const receiver = field(call, "receiver");
  if (
    EXIT_METHODS[method] === undefined ||
    (receiver !== null && receiver.text !== "Kernel")
  ) {
    return null;
  }
  const code =
    method === "abort"
      ? null
      : (readCallArgs(field(call, "arguments")).positional[0] ?? null);
  return { call, method, code };
}

/** The exit terminal for one call, with the code it hands over. */
export function exitTerminal(site: ExitSite, facts?: Database): RawTerminal {
  return {
    kind: "exit",
    statusCode: exitCodeOf(site, facts),
    body: null,
    exceptionType: null,
    message: null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location: rangeOf(site.call),
  };
}

const BOOLEAN_CODES: Readonly<Record<string, number>> = { true: 0, false: 1 };

function exitCodeOf(
  site: ExitSite,
  facts: Database | undefined,
): RawTerminal["statusCode"] {
  const { code } = site;
  if (code === null) {
    return { type: "literal", value: EXIT_METHODS[site.method] ?? 0 };
  }
  const written = BOOLEAN_CODES[code.type];
  if (written !== undefined) {
    return { type: "literal", value: written };
  }
  const value = constantOf(evaluatedValue(code, facts));
  return typeof value === "number"
    ? { type: "literal", value }
    : { type: "dynamic", sourceText: code.text };
}

/**
 * One branch per path through a reached method that ends the process,
 * the returns and the end of the body included. Null when the method
 * never ends the process, and then it keeps its one transition.
 */
export function exitingBranches(
  method: RbNode,
  effects: readonly RawEffect[],
  facts?: Database,
): RawBranch[] | null {
  const body = field(method, "body");
  const sites = body === null ? [] : exitSites(body);
  if (sites.length === 0) {
    return null;
  }
  const exits: EndingCall[] = sites.map((site) => ({
    call: site.call,
    terminal: exitTerminal(site, facts),
  }));
  return returnPathBranches(method, effects, exits);
}

/** The places each file ends the process, for the run to ask about once. */
export interface FileExits {
  /** The absolute path, which facts key a node on. */
  file: string;
  sites: readonly ExitSite[];
}

/**
 * Marks each summary whose return becomes the exit code, as `exit(main)`
 * makes `main`'s. The value each exit hands over seeds the same question
 * the TypeScript adapter asks, over this run's facts.
 */
export function markExitCodeFunctions(
  summaries: readonly BehavioralSummary[],
  exits: readonly FileExits[],
  facts: Database,
  workspaceRoot: string | undefined,
): void {
  const sinks = exits.flatMap(({ file, sites }) =>
    sites.flatMap((site) =>
      site.code === null ? [] : [nodeId(file, site.code)],
    ),
  );
  markReturnsAsExitCode(
    summaries,
    exitCodeFunctions(facts, sinks),
    workspaceRoot,
  );
}
