/**
 * The methods a controller runs around its actions.
 *
 * `before_action :require_login` tells the library to call a method
 * before the action, and the request ends there when that method
 * responds. `rescue_from SomeError, with: :not_found` gives a method it
 * calls when the action raised. Either can take a block in place of the
 * method, which then runs instead. Both are written in the class body,
 * inherited by subclasses, narrowed by `only:` and `except:`, and removed
 * again by `skip_before_action`. Each filter method gets a unit of its
 * own, and each action it covers records a reference to that unit.
 */

import {
  inheritedStatements,
  methodInAncestry,
  methodPastUnreadAncestors,
} from "./ancestry.js";
import { field, rangeOf, readCallArgs, spanOf } from "./ast.js";
import { withSlotSources } from "./provenance.js";
import { responseBranches } from "./responseStatus.js";
import { constantRefCandidates } from "./scope.js";
import { stringValueOf } from "./values/evaluator.js";
import { namesOf } from "./values/literals.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, RawCodeStructure } from "@suss/extractor";
import type {
  Ancestry,
  BodyReading,
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
import type { Range } from "./ast.js";
import type { ControllerActions, RbControllerFilter } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { HandlerClasses, RaisesRead } from "./raisedStatuses.js";
import type { RespondingHelper } from "./responseStatus.js";
import type { ConstantRef } from "./scope.js";

/** One filter the ancestry declares, resolved to its method. */
export interface ControllerFilter {
  readonly filter: RbControllerFilter;
  /** The method's name, or for a handler written as a block, a label made up from the declaration. */
  readonly methodName: string;
  readonly nameKind: "binding" | "label";
  /** The `def` of the filter's method, or the block a handler is written as. */
  readonly method: RbNode;
  /** Absolute path of the file that `def` is written in. */
  readonly file: string;
  readonly enclosingQualifiedName: string;
  /** `Module.nesting` inside the class body the method is written in. */
  readonly nesting: readonly string[];
  /** The actions it covers. Null means every action of the controller. */
  readonly only: ReadonlySet<string> | null;
  readonly except: ReadonlySet<string>;
  readonly rescues: Rescues;
}

/**
 * For a handler the library runs after a raise, the exception classes it
 * is declared for. `someUnread` says one of them is not a constant the
 * run can read, such as `*NETWORK_ERRORS`, so the handler may catch anything.
 */
export interface Rescues {
  readonly refs: readonly ConstantRef[];
  readonly someUnread: boolean;
}

const RESCUES_NOTHING: Rescues = { refs: [], someUnread: false };

/** A filter declaration, before its method has been looked up. */
interface Declaration {
  readonly filter: RbControllerFilter;
  readonly methodName: string;
  readonly only: ReadonlySet<string> | null;
  readonly except: ReadonlySet<string>;
  readonly rescues: Rescues;
  /** The block given in place of a method, read as the filter when no method by that name is found. */
  readonly inline?: InlineHandler;
}

interface InlineHandler {
  readonly block: RbNode;
  readonly label: string;
  readonly declaredIn: ReachedBody;
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
 * as declared, ancestors first. The ones that run only after a raise
 * come last, in the order the library tries them, last declared first.
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

  // Built the way the library builds it, in declaration order with
  // ancestors first. A method declared again moves to the end with its
  // new options, and a skip changes only what is in the chain so far.
  let declared: Declaration[] = [];
  const inlineSeen = new Map<string, number>();
  for (const { block, statement } of inheritedStatements(ancestry)) {
    const called = calledName(statement);
    if (called === null) {
      continue;
    }
    const form = byName.get(called);
    if (form !== undefined) {
      const inlineKey = `${block.file}\u0000${block.info.qualifiedName}\u0000${form.name}`;
      const ordinal = inlineSeen.get(inlineKey) ?? 0;
      const declarations = declarationsOf(
        statement,
        form,
        block,
        read.facts,
        ordinal,
      );
      if (declarations.some((one) => one.inline !== undefined)) {
        inlineSeen.set(inlineKey, ordinal + 1);
      }
      for (const declaration of declarations) {
        // A handler named in a second `rescue_from` keeps its first
        // registration where it was, since the library tries each in turn.
        const earlier =
          declaration.filter.onThrow === true
            ? undefined
            : declared.find((one) => sameFilter(one, declaration));
        declared = [...declared.filter((one) => one !== earlier), declaration];
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
    const written = writtenAt(
      declaration,
      filterMethod(ancestry, declaration.methodName, read),
    );
    if (written === null) {
      continue;
    }
    resolved.push({
      filter: declaration.filter,
      ...written,
      only: declaration.only,
      except: declaration.except,
      rescues: declaration.rescues,
    });
  }

  return [
    ...resolved.filter((one) => one.filter.onThrow !== true),
    ...resolved.filter((one) => one.filter.onThrow === true).reverse(),
  ];
}

type WrittenAt = Pick<
  ControllerFilter,
  | "methodName"
  | "nameKind"
  | "method"
  | "file"
  | "enclosingQualifiedName"
  | "nesting"
>;

/**
 * Where the code a filter runs is written: the method the declaration
 * gives, or the block a handler was declared with when no method by that
 * name is found.
 */
function writtenAt(
  declaration: Declaration,
  found: MethodLookup,
): WrittenAt | null {
  if (found.type === "found") {
    return {
      methodName: declaration.methodName,
      nameKind: "binding",
      method: found.method,
      file: found.block.file,
      enclosingQualifiedName: found.block.info.qualifiedName,
      nesting: found.block.info.bodyNesting,
    };
  }

  const inline = declaration.inline;
  if (inline === undefined) {
    return null;
  }
  return {
    methodName: inline.label,
    nameKind: "label",
    method: inline.block,
    file: inline.declaredIn.file,
    enclosingQualifiedName: inline.declaredIn.info.qualifiedName,
    nesting: inline.declaredIn.info.bodyNesting,
  };
}

/**
 * The method a filter runs. A controller that includes a library module
 * would otherwise lose every filter its ancestors define, since the
 * module comes before them in the lookup.
 */
function filterMethod(
  ancestry: Ancestry,
  name: string,
  read: BodyReading,
): MethodLookup {
  const found = methodInAncestry(ancestry, name, read);
  if (found.type === "unsettled" && found.cause === "unreadAncestor") {
    return methodPastUnreadAncestors(ancestry, name, read);
  }
  return found;
}

/** Whether the library runs this filter for the given action. */
export function filterCoversAction(
  filter: ControllerFilter,
  actionName: string,
): boolean {
  if (filter.except.has(actionName)) {
    return false;
  }
  return filter.only === null || filter.only.has(actionName);
}

/**
 * The reference an action records, which points at the filter's own
 * unit. `caught` gives a handler's exception classes as the run read them.
 */
export function filterReference(
  filter: ControllerFilter,
  displayPath: string,
  caught?: HandlerClasses,
): WrapperReference {
  return {
    file: displayPath,
    name: filter.methodName,
    ...(filter.filter.onThrow === true ? { onThrow: true } : {}),
    ...(caught === undefined
      ? {}
      : {
          catches: caught.classes.map((one) => one.name),
          ...(caught.classes.some((one) => one.inheritableByUnread)
            ? { mayCatchUnreadClasses: true }
            : {}),
          ...(caught.someUnread ? { mayCatchAny: true } : {}),
        }),
  };
}

/** What the filter method's body does, as `bodyOfMethod` reports it. */
export interface FilterBody {
  effects?: RawBranch["effects"];
  extraEffects?: RawBranch["extraEffects"];
  provenance?: RawBranch["provenance"];
  bodyContent?: RawCodeStructure["bodyContent"];
}

/** What reading a filter's body needs besides the body. */
export interface FilterReading {
  facts?: Database | undefined;
  respondingHelper?: RespondingHelper;
  /** What the raises written in the filter raise. */
  raises?: RaisesRead;
  /** The branches for exceptions the filter's model calls raise. */
  raised?: readonly RawBranch[];
}

/**
 * The unit for one filter method. A path that responds ends the
 * request, a path that raises ends it with what the raise ends with, and
 * every other path hands it on as a `delegate` branch.
 */
export function filterUnit(
  filter: ControllerFilter,
  pattern: ControllerActions,
  displayPath: string,
  body: FilterBody,
  reading: FilterReading = {},
): RawCodeStructure {
  const range = rangeOf(filter.method);
  const { respondingHelper, raises } = reading;
  const branches = responseBranches(
    filter.method,
    pattern,
    body.effects ?? [],
    body.extraEffects,
    {
      fallthrough: "handOn",
      facts: reading.facts,
      ...(respondingHelper === undefined ? {} : { respondingHelper }),
      ...(raises === undefined ? {} : { raises }),
    },
  );
  return {
    identity: {
      name: filter.methodName,
      nameKind: filter.nameKind,
      kind: "middleware",
      file: displayPath,
      range,
      span: spanOf(filter.method),
      exportName: filter.nameKind === "binding" ? filter.methodName : null,
      exportPath: [filter.enclosingQualifiedName, filter.methodName],
    },
    boundaryBinding: null,
    parameters: [],
    branches: withSlotSources(
      [...(branches ?? [handsOn(range, body)]), ...(reading.raised ?? [])],
      body.provenance,
    ),
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

/** The method a receiverless call statement invokes, such as `before_action`. */
function calledName(statement: RbNode): string | null {
  if (statement.type !== "call" || field(statement, "receiver") !== null) {
    return null;
  }
  return field(statement, "method")?.text ?? null;
}

/** One declaration per method, since `before_action :a, :b` registers two. */
function declarationsOf(
  statement: RbNode,
  filter: RbControllerFilter,
  declaredIn: ReachedBody,
  facts: Database | undefined,
  inlineOrdinal: number,
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
  const rescues =
    filter.onThrow === true
      ? rescuedClasses(args, declaredIn.info.bodyNesting, facts)
      : RESCUES_NOTHING;
  const inline = inlineHandler(
    statement,
    args,
    filter,
    declaredIn,
    inlineOrdinal,
  );
  return methodNamesOf(args, filter, facts, inline).map((methodName) => ({
    filter,
    methodName,
    only,
    except: except ?? new Set<string>(),
    rescues,
    ...(inline === undefined ? {} : { inline }),
  }));
}

/**
 * The block a filter is declared with in place of a method. It has no
 * name of its own, so its label counts the blocks declared that way in
 * the class, `rescue_from#0` for the first, and stays the same when the
 * classes it rescues are renamed.
 */
function inlineHandler(
  statement: RbNode,
  args: ReturnType<typeof readCallArgs>,
  filter: RbControllerFilter,
  declaredIn: ReachedBody,
  ordinal: number,
): InlineHandler | undefined {
  const block = blockInPlaceOfMethod(statement, args, filter);
  if (block === null || blockStatements(block).length === 0) {
    return undefined;
  }
  return { block, label: `${filter.name}#${ordinal}`, declaredIn };
}

/**
 * The classes a handler is declared for, each written as a constant or,
 * as Rails also accepts, as a string with the class's name.
 */
function rescuedClasses(
  args: ReturnType<typeof readCallArgs>,
  nesting: readonly string[],
  facts: Database | undefined,
): Rescues {
  const refs: ConstantRef[] = [];
  let someUnread = args.positional.length === 0;
  for (const arg of args.positional) {
    const candidates = constantRefCandidates(arg, nesting);
    const named = candidates.length === 0 ? stringValueOf(arg, facts) : null;
    if (candidates.length === 0 && named === null) {
      someUnread = true;
      continue;
    }
    refs.push({
      text: arg.text,
      candidates: named === null ? candidates : [named],
    });
  }
  return { refs, someUnread };
}

function methodNamesOf(
  args: ReturnType<typeof readCallArgs>,
  filter: RbControllerFilter,
  facts: Database | undefined,
  inline: InlineHandler | undefined,
): string[] {
  const named =
    filter.methodFrom === "withKeyword"
      ? withKeywordName(args, facts)
      : symbolArgumentNames(args, facts);
  if (named.length > 0 || inline === undefined) {
    return named;
  }
  return [blockHandlerName(inline.block) ?? inline.label];
}

function withKeywordName(
  args: ReturnType<typeof readCallArgs>,
  facts: Database | undefined,
): string[] {
  const named = args.keyword.with;
  const value = named === undefined ? null : stringValueOf(named, facts);
  return value === null ? [] : [value];
}

/**
 * The block a filter is declared with in place of a method: a block in
 * place of `rescue_from`'s `with:`, or a block or lambda in place of a
 * `before_action` symbol.
 */
function blockInPlaceOfMethod(
  statement: RbNode,
  args: ReturnType<typeof readCallArgs>,
  filter: RbControllerFilter,
): RbNode | null {
  if (filter.methodFrom === "withKeyword") {
    return args.keyword.with === undefined ? field(statement, "block") : null;
  }

  const lambda = args.positional.find((arg) => arg.type === "lambda");
  if (lambda !== undefined) {
    return field(lambda, "body");
  }
  return args.positional.length === 0 ? field(statement, "block") : null;
}

function blockStatements(block: RbNode): RbNode[] {
  return (field(block, "body")?.namedChildren ?? []).filter(
    (child): child is RbNode => child !== null && child.type !== "comment",
  );
}

/**
 * The method a filter's block hands on to, when the block is one call
 * with no receiver: `{ |e| render_denied e }`. When no method by that
 * name is found, or the block does more, the block itself is read as the
 * filter.
 */
function blockHandlerName(block: RbNode): string | null {
  const statements = blockStatements(block);
  const only = statements.length === 1 ? statements[0] : undefined;
  if (only === undefined) {
    return null;
  }
  const parameters = new Set(
    (field(block, "parameters")?.namedChildren ?? []).map(
      (parameter) => parameter?.text,
    ),
  );
  if (only.type === "identifier") {
    return parameters.has(only.text) ? null : only.text;
  }
  return calledName(only);
}

/** The method names a class body call passes as leading symbols, `:a` and `:b` in `before_action :a, :b`. */
export function symbolArgumentNames(
  args: ReturnType<typeof readCallArgs>,
  facts: Database | undefined,
): string[] {
  return args.positional
    .map((arg) => stringValueOf(arg, facts))
    .filter((name): name is string => name !== null);
}

/** A skip identifies its filters by method name, the same way a filter declaration does. */
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
 * What is left once the skips are applied. A skip that lists no actions
 * removes the filter altogether.
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
