/**
 * filters.ts: the methods a controller runs around its actions.
 *
 * `before_action :require_login` names a method the library calls
 * before the action, and the request ends there when that method
 * responds. `rescue_from SomeError, with: :not_found` names one it
 * calls when the action raised. Both are written in the class body,
 * inherited down the chain, narrowed by `only:` and `except:`, and
 * taken back off by `skip_before_action`. Each filter method gets a
 * unit of its own and each action it covers records it; the README
 * says what composition does with the two.
 */

import { inheritedStatements, methodInAncestry } from "./ancestry.js";
import { field, rangeOf, readCallArgs, spanOf } from "./ast.js";
import { responseBranches } from "./responseStatus.js";
import { stringValueOf } from "./values/evaluator.js";
import { namesOf } from "./values/literals.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, RawCodeStructure } from "@suss/extractor";
import type { Ancestry, BodyReading } from "./ancestry.js";
import type { Range } from "./ast.js";
import type { ControllerActions, RbControllerFilter } from "./pack.js";
import type { RbNode } from "./parser.js";

/** One filter the ancestry declares, resolved to the method it names. */
export interface ControllerFilter {
  readonly filter: RbControllerFilter;
  readonly methodName: string;
  /** The `def` the filter names. */
  readonly method: RbNode;
  /** Absolute path of the file that `def` is written in. */
  readonly file: string;
  readonly enclosingQualifiedName: string;
  /** The actions it covers. Null means every action of the controller. */
  readonly only: ReadonlySet<string> | null;
  readonly except: ReadonlySet<string>;
}

/** A filter declaration, before the method it names has been looked up. */
interface Declaration {
  readonly filter: RbControllerFilter;
  readonly methodName: string;
  readonly only: ReadonlySet<string> | null;
  readonly except: ReadonlySet<string>;
}

/** A `skip_before_action`, which takes a filter off some or all of the actions. */
interface Skip {
  readonly filterName: string;
  readonly methodName: string;
  /** The actions it takes the filter off, or null for all of them. */
  readonly actions: ReadonlySet<string> | null;
}

/**
 * Every filter a controller runs, in the order the library runs them:
 * as declared, ancestors first, with the ones that run only after a
 * raise last.
 */
export function controllerFilters(
  pattern: ControllerActions,
  ancestry: Ancestry,
  read: BodyReading = {},
): ControllerFilter[] {
  const forms = pattern.filters ?? [];
  if (forms.length === 0) {
    return [];
  }

  const byName = new Map(forms.map((form) => [form.name, form]));
  const skipNames = new Map<string, string>();
  for (const form of forms) {
    if (form.skippedBy !== undefined) {
      skipNames.set(form.skippedBy, form.name);
    }
  }

  // The chain is built in declaration order, ancestors first, the way
  // the library builds it: a method declared again moves to the end
  // with its new options, and a skip edits what is in the chain so far.
  let declared: Declaration[] = [];
  for (const { statement } of inheritedStatements(ancestry)) {
    const called = calledName(statement);
    if (called === null) {
      continue;
    }
    const form = byName.get(called);
    if (form !== undefined) {
      for (const declaration of declarationsOf(statement, form, read.facts)) {
        declared = [
          ...declared.filter((earlier) => !sameFilter(earlier, declaration)),
          declaration,
        ];
      }
      continue;
    }
    const skipped = skipNames.get(called);
    if (skipped !== undefined) {
      declared = applySkips(declared, skipsOf(statement, skipped, read.facts));
    }
  }

  const resolved: ControllerFilter[] = [];
  for (const declaration of declared) {
    const found = methodInAncestry(ancestry, declaration.methodName, read);
    if (found.type !== "found") {
      continue;
    }
    resolved.push({
      filter: declaration.filter,
      methodName: declaration.methodName,
      method: found.method,
      file: found.block.file,
      enclosingQualifiedName: found.block.info.qualifiedName,
      only: declaration.only,
      except: declaration.except,
    });
  }

  return [
    ...resolved.filter((one) => one.filter.onThrow !== true),
    ...resolved.filter((one) => one.filter.onThrow === true),
  ];
}

/** Whether the library runs this filter for the action named. */
export function filterCoversAction(
  filter: ControllerFilter,
  actionName: string,
): boolean {
  if (filter.except.has(actionName)) {
    return false;
  }
  return filter.only === null || filter.only.has(actionName);
}

/** The reference an action records, which points at the filter's own unit. */
export function filterReference(
  filter: ControllerFilter,
  displayPath: string,
): WrapperReference {
  return {
    file: displayPath,
    name: filter.methodName,
    ...(filter.filter.onThrow === true ? { onThrow: true } : {}),
  };
}

/** What reading the filter method's body came to, as `bodyOfMethod` reports it. */
export interface FilterBody {
  effects?: RawBranch["effects"];
  extraEffects?: RawBranch["extraEffects"];
  bodyContent?: RawCodeStructure["bodyContent"];
}

/**
 * The unit for one filter method. A path that responds ends the
 * request, and every other path hands it on as a `delegate` branch.
 */
export function filterUnit(
  filter: ControllerFilter,
  pattern: ControllerActions,
  displayPath: string,
  body: FilterBody,
  facts?: Database | undefined,
): RawCodeStructure {
  const range = rangeOf(filter.method);
  const branches = responseBranches(
    filter.method,
    pattern,
    body.effects ?? [],
    body.extraEffects,
    { fallthrough: "handOn", facts },
  );
  return {
    identity: {
      name: filter.methodName,
      nameKind: "binding",
      kind: "middleware",
      file: displayPath,
      range,
      span: spanOf(filter.method),
      exportName: filter.methodName,
      exportPath: [filter.enclosingQualifiedName, filter.methodName],
    },
    boundaryBinding: null,
    parameters: [],
    branches: branches ?? [handsOn(range, body)],
    bodyContent: body.bodyContent ?? "absent",
    dependencyCalls: [],
    declaredContract: null,
  };
}

/** The one branch of a filter whose body writes no response at all. */
function handsOn(range: Range, body: FilterBody): RawBranch {
  return {
    conditions: [],
    terminal: {
      kind: "delegate",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: range,
    },
    effects: body.effects ?? [],
    ...(body.extraEffects === undefined
      ? {}
      : { extraEffects: body.extraEffects }),
    location: range,
    isDefault: true,
  };
}

/** The name of a receiverless call written as a statement, `before_action`. */
function calledName(statement: RbNode): string | null {
  if (statement.type !== "call" || field(statement, "receiver") !== null) {
    return null;
  }
  return field(statement, "method")?.text ?? null;
}

/** One declaration per method the call names, since `before_action :a, :b` names two. */
function declarationsOf(
  statement: RbNode,
  filter: RbControllerFilter,
  facts: Database | undefined,
): Declaration[] {
  const args = readCallArgs(field(statement, "arguments"));
  const keywords = filter.actionKeywords;
  const only =
    keywords === undefined
      ? null
      : actionsUnder(args.keyword[keywords.include], facts);
  const except =
    keywords === undefined
      ? null
      : actionsUnder(args.keyword[keywords.exclude], facts);
  return methodNamesOf(args, filter, facts).map((methodName) => ({
    filter,
    methodName,
    only,
    except: except ?? new Set<string>(),
  }));
}

function methodNamesOf(
  args: ReturnType<typeof readCallArgs>,
  filter: RbControllerFilter,
  facts: Database | undefined,
): string[] {
  if (filter.methodFrom === "withKeyword") {
    const named = args.keyword.with;
    const value = named === undefined ? null : stringValueOf(named, facts);
    return value === null ? [] : [value];
  }
  return args.positional
    .map((arg) => stringValueOf(arg, facts))
    .filter((name): name is string => name !== null);
}

/** A skip names its filters by method, the way the filter itself does. */
function skipsOf(
  statement: RbNode,
  filterName: string,
  facts: Database | undefined,
): Skip[] {
  const args = readCallArgs(field(statement, "arguments"));
  const actions = actionsUnder(args.keyword.only, facts);
  return args.positional
    .map((arg) => stringValueOf(arg, facts))
    .filter((name): name is string => name !== null)
    .map((methodName) => ({ filterName, methodName, actions }));
}

/** Whether two declarations register the same method through the same call. */
function sameFilter(one: Declaration, other: Declaration): boolean {
  return (
    one.filter.name === other.filter.name && one.methodName === other.methodName
  );
}

/**
 * What is left once the skips are applied. A skip that names no actions
 * takes the filter off altogether.
 */
function applySkips(
  declared: readonly Declaration[],
  skips: readonly Skip[],
): Declaration[] {
  const left: Declaration[] = [];
  for (const declaration of declared) {
    const reaching = skips.filter(
      (skip) =>
        skip.filterName === declaration.filter.name &&
        skip.methodName === declaration.methodName,
    );
    if (reaching.some((skip) => skip.actions === null)) {
      continue;
    }
    const except = new Set(declaration.except);
    for (const skip of reaching) {
      for (const action of skip.actions ?? []) {
        except.add(action);
      }
    }
    left.push({ ...declaration, except });
  }
  return left;
}

/** The actions a keyword's value comes down to: one symbol, or an array of them. */
function actionsUnder(
  node: RbNode | undefined,
  facts: Database | undefined,
): ReadonlySet<string> | null {
  if (node === undefined) {
    return null;
  }
  const found = namesOf(node, facts);
  return found === null ? null : new Set(found);
}
