/**
 * The hooks a GraphQL library runs on a wired class before the method
 * that resolves the field. graphql-ruby runs `ready?`, then
 * `authorized?`, then `resolve`, and either hook can end the field before
 * `resolve` runs.
 *
 * Each hook definition that runs becomes a unit of its own, and the
 * field records it as a wrapper, the way a controller action records a
 * `before_action` filter. Composition then puts the paths on which a
 * hook stops the field beside the field's own outcome. The pack lists
 * the hooks and says how the library reads a hook's answer, so none of
 * the library's method names appear here.
 */

import {
  SKIP_CHILDREN,
  unreadableReading,
  walkDescendants,
} from "@suss/extractor";
import { constantOf } from "@suss/values";

import { methodInAncestry } from "./ancestry.js";
import {
  bodyStatements,
  children,
  field,
  METHOD_TYPES,
  rangeOf,
  spanOf,
} from "./ast.js";
import { withSlotSources } from "./provenance.js";
import { raiseEndings } from "./responseHandOff.js";
import { returnPathBranches } from "./responseStatus.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  RawBranch,
  RawCodeStructure,
  RawTerminal,
  Reading,
} from "@suss/extractor";
import type { Value } from "@suss/values";
import type {
  Ancestry,
  BodyReading,
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
import type { Range } from "./ast.js";
import type { BodyReport } from "./discovery.js";
import type { RbResolverHooks } from "./pack.js";
import type { RbNode } from "./parser.js";

/** One definition of a hook that runs for a wired class. */
export interface HookDefinition {
  readonly name: string;
  readonly method: RbNode;
  readonly block: ReachedBody;
}

/** The hook definitions that run for a class, in the order they run, and what could not be settled about the rest. */
export interface HooksRun {
  readonly definitions: readonly HookDefinition[];
  /** For each hook the lookup could not settle, the reason, finishing "could be stopped by a hook ...". */
  readonly unsettled: readonly { name: string; reason: string }[];
}

export function hooksRun(
  ancestry: Ancestry,
  hooks: RbResolverHooks,
  read: BodyReading,
): HooksRun {
  const definitions: HookDefinition[] = [];
  const unsettled: { name: string; reason: string }[] = [];
  for (const name of hooks.methods) {
    const found = definitionsRun(ancestry, name, read);
    definitions.push(...found.definitions);
    if (found.unsettled !== null) {
      unsettled.push({ name, reason: found.unsettled });
    }
  }
  return { definitions, unsettled };
}

/**
 * The nearest definition of one hook, then the next one along the
 * ancestry for as long as each calls `super`. The library's own default
 * at the end of the chain lets the field go on, so it adds nothing.
 */
function definitionsRun(
  ancestry: Ancestry,
  name: string,
  read: BodyReading,
): { definitions: HookDefinition[]; unsettled: string | null } {
  const definitions: HookDefinition[] = [];
  let rest = ancestry;
  while (rest.length > 0) {
    const lookup = methodInAncestry(rest, name, read);
    if (lookup.type !== "found") {
      return { definitions, unsettled: unsettledReason(lookup) };
    }

    definitions.push({ name, method: lookup.method, block: lookup.block });
    if (!callsSuper(lookup.method)) {
      break;
    }
    const at = rest.findIndex(
      (entry) => entry.type === "bodies" && entry.blocks.includes(lookup.block),
    );
    if (at === -1) {
      break;
    }
    rest = rest.slice(at + 1);
  }
  return { definitions, unsettled: null };
}

/**
 * Why a hook lookup did not settle, when a reader would lose something by
 * not being told. An unread ancestor in front of every project
 * definition is usually a gem's module that defines no hook, so the
 * lookup says nothing then. It speaks up when the project does define the
 * hook further along, or when `define_method` may define it.
 */
function unsettledReason(lookup: MethodLookup): string | null {
  if (lookup.type !== "unsettled") {
    return null;
  }
  return lookup.cause === "dynamicDefine" || lookup.definedLater === true
    ? lookup.reason
    : null;
}

/** Whether the method's own body calls `super`, with or without arguments. */
function callsSuper(method: RbNode): boolean {
  let found = false;
  walkDescendants<RbNode, null>(method, null, children, {
    at: (node) => {
      found ||= isSuper(node);
    },
    into: (node) =>
      node !== method && METHOD_TYPES.has(node.type) ? SKIP_CHILDREN : null,
  });
  return found;
}

function isSuper(node: RbNode): boolean {
  return (
    node.type === "super" ||
    (node.type === "call" && field(node, "method")?.type === "super")
  );
}

/** What a hook's unit is built from besides the hook itself. */
export interface HookUnitInput {
  readonly hooks: RbResolverHooks;
  /** What `bodyOfMethod` read of the hook's body. */
  readonly body: BodyReport;
  readonly displayPath: string;
  readonly facts: Database | undefined;
}

/**
 * A hook as a unit: one branch per path through it. A path that raises
 * throws, a path whose answer is false or nil returns in place of the
 * field, and every other path hands the field on.
 */
export function hookUnit(
  hook: HookDefinition,
  input: HookUnitInput,
): RawCodeStructure {
  const { body, facts } = input;
  const range = rangeOf(hook.method);
  const extraEffects = body.extraEffects;
  const branches = (
    returnPathBranches(
      hook.method,
      body.effects ?? [],
      [],
      facts,
      undefined,
      raiseEndings(hook.method),
      (statement, location) =>
        hookEnding(hook.method, statement, location, input),
    ) ?? [goOnBranch(range)]
  ).map(
    (branch): RawBranch =>
      extraEffects === undefined ? branch : { ...branch, extraEffects },
  );
  return {
    identity: {
      name: hook.name,
      nameKind: "binding",
      kind: "middleware",
      file: input.displayPath,
      range,
      span: spanOf(hook.method),
      exportName: hook.name,
      exportPath: [hook.block.info.qualifiedName, hook.name],
    },
    boundaryBinding: null,
    parameters: [],
    branches: withSlotSources(branches, body.provenance),
    bodyContent: body.bodyContent ?? "absent",
    dependencyCalls: [],
    declaredContract: null,
  };
}

/** How the field refers to a hook's unit. Two classes in one file can each define the hook, and the line tells them apart. */
export function hookReference(
  hook: HookDefinition,
  displayPath: string,
): WrapperReference {
  return {
    file: displayPath,
    name: hook.name,
    line: rangeOf(hook.method).start,
  };
}

/** The reading a field gets for a hook whose lookup did not settle. */
export function unsettledHookReading(
  className: string,
  unsettled: { name: string; reason: string },
  range: Range,
): Reading<unknown> {
  return unreadableReading(
    `This field's ${className} could be stopped by a ${unsettled.name} hook ${unsettled.reason}, so whether one runs was not settled here`,
    range,
  );
}

/** Whether the path that returns at `statement`, or runs off the end of the body when it is null, stops the field. */
function hookEnding(
  method: RbNode,
  statement: RbNode | null,
  location: Range,
  input: HookUnitInput,
): RawTerminal {
  const values =
    statement === null ? lastStatement(method) : returnedValues(statement);
  return stopsTheField(values, input)
    ? endingTerminal("return", location)
    : goOn(location);
}

function lastStatement(method: RbNode): RbNode[] {
  const body = field(method, "body");
  const last = body === null ? undefined : bodyStatements(body).at(-1);
  return last === undefined ? [] : [last];
}

/** The values a `return` statement writes: none, one, or several for `return a, b`. */
function returnedValues(statement: RbNode): RbNode[] {
  const list = children(statement)[0];
  if (list === undefined) {
    return [];
  }
  return list.type === "argument_list" ? children(list) : [list];
}

/**
 * Whether the values a path ends on stop the field. A `return` with no
 * value returns nil. `return a, b` hands back a list, and so does
 * `[a, b]`, and a list is never false in Ruby. A library that reads a
 * list's first element as the answer takes `a` from either.
 */
function stopsTheField(
  values: readonly RbNode[],
  input: HookUnitInput,
): boolean {
  const first = values[0];
  if (first === undefined) {
    return true;
  }
  const listHead = input.hooks.answerIsListHead === true;
  if (values.length > 1) {
    return listHead && isFalsy(evaluatedValue(first, input.facts));
  }
  const value = evaluatedValue(first, input.facts);
  if (value.kind !== "sequence") {
    return isFalsy(value);
  }
  const head = value.items[0];
  return listHead && head !== undefined && isFalsy(head.value);
}

/** Ruby treats only false and nil as false. */
function isFalsy(value: Value): boolean {
  const settled = constantOf(value);
  return settled === false || settled === null;
}

function goOnBranch(location: Range): RawBranch {
  return {
    conditions: [],
    terminal: goOn(location),
    effects: [],
    location,
    isDefault: true,
  };
}

function goOn(location: Range): RawTerminal {
  return endingTerminal("delegate", location);
}

function endingTerminal(
  kind: "return" | "delegate",
  location: Range,
): RawTerminal {
  return {
    kind,
    statusCode: null,
    body: null,
    exceptionType: null,
    message: null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location,
  };
}
