/**
 * Reads `config/routes.rb`, or the file a project points this pack at,
 * into a table from controller action to HTTP method and path.
 *
 * The grammar is fixed on purpose, and the README lists every call it
 * covers and where each one stops. A call outside it, such as `direct`
 * or a gem's own routing call, is left unread and reported once per file
 * as a gap. A gem's block whose body is written in the grammar is walked
 * as if the call were not there.
 *
 * Each file is read through the module ops the Ruby adapter states for
 * it on its own: a call's name, its arguments, its block, and the calls
 * a block writes as statements.
 */

import fs from "node:fs";
import path from "node:path";

import { moduleOpsForFile } from "@suss/adapter-ruby";

import { pathWithOptionalGroups } from "./optionalSegments.js";

import type { CallOps, ModuleOps, PairArg, ValueOps } from "@suss/extractor";
import type { RailsEngine } from "./engines.js";

export interface Route {
  method: string;
  path: string;
  /** True for a route that says `format: false`, which Rails serves with no `.:format` after its path. */
  formatless?: true;
}

export interface RouteTable {
  /**
   * Every method and path that reaches one controller's action, in the
   * order the file declares them, or none. `controllerKey` is lowercase
   * and slash-joined the way the routes file writes it: `admin/orders`
   * for `namespace :admin do resources :orders end`.
   */
  routesFor(controllerKey: string, actionName: string): Route[];
  /** Messages about declarations left unread, or one saying the routes file does not exist. */
  readonly gaps: readonly string[];
  /**
   * False when the routes file does not exist. Only then does a caller
   * fall back to the naming convention.
   */
  readonly fileFound: boolean;
}

interface ResourceScope {
  controllerKey: string;
  collectionBase: string;
  memberBase: string;
  /**
   * The prefix a resource nested one level inside this one goes under:
   * `/orders/:order_id` for a plural resource, and the resource's own
   * path for a singular one, which has no id.
   */
  nestedBase: string;
  /**
   * The base a bare verb with no `on:` uses: `nestedBase` directly inside
   * a resource block, and the member or collection base inside a `member`
   * or `collection` block.
   */
  ambientBase: string;
}

interface RouteContext {
  pathPrefix: string;
  modulePrefix: string;
  resource?: ResourceScope;
  /** Keywords an enclosing `with_options` gives every call inside it; a call's own keyword wins. */
  defaults: Readonly<Record<string, ValueOps>>;
  /**
   * The loop variables an enclosing `%w[a b].each do |name|` binds, so a
   * string that interpolates `name` reads as a literal.
   */
  bindings?: ReadonlyMap<string, string>;
}

/** Every keyword a routing call here reads, and so every one `with_options` can hand down. */
const KEYWORDS = [
  "to",
  "on",
  "action",
  "controller",
  "format",
  "path",
  "module",
  "only",
  "except",
  "concerns",
  "via",
  "at",
] as const;

interface SimpleArgs {
  positional: ValueOps[];
  keyword: Record<string, ValueOps>;
  /** The last `"path" => "controller#action"` argument, whose key is a value rather than a keyword. */
  pair: PairArg | null;
}

function readSimpleArgs(
  call: CallOps,
  defaults: Readonly<Record<string, ValueOps>> = {},
): SimpleArgs {
  const pairs = call.pairArgs?.() ?? [];
  // A string key is a keyword to the adapter as well, and a pair to Rails.
  const pairKeys = new Set(pairs.map((pair) => pair.key.text()));
  const keyword: Record<string, ValueOps> = { ...defaults };
  for (const name of KEYWORDS) {
    const value = pairKeys.has(name) ? null : (call.keywordAt?.(name) ?? null);
    if (value !== null) {
      keyword[name] = value;
    }
  }
  const positional: ValueOps[] = [];
  for (let at = 0; at < call.argumentCount(); at++) {
    const value = call.valueAt(at);
    if (value !== null) {
      positional.push(value);
    }
  }
  return { positional, keyword, pair: pairs[pairs.length - 1] ?? null };
}

/**
 * The string a value comes to: a loop variable it names, or else what it
 * evaluates to with the loop variables bound. A symbol reads as its name.
 */
function textValue(
  value: ValueOps | undefined,
  ctx: RouteContext,
): string | null {
  if (value === undefined) {
    return null;
  }
  const bound =
    value.form?.() === "name"
      ? ctx.bindings?.get(value.source?.() ?? "")
      : undefined;
  if (bound !== undefined) {
    return bound;
  }
  const evaluated = value.evaluatedWith?.(ctx.bindings ?? new Map()) ?? null;
  return typeof evaluated === "string" ? evaluated : null;
}

/** Whether the source writes the value out as a list here: `[...]`, `%w[]` or `%i[]`. */
function writtenAsList(value: ValueOps): boolean {
  return value.shape?.()?.type === "array";
}

function splitControllerAction(
  text: string,
): { controllerKey: string; action: string } | null {
  const index = text.indexOf("#");
  if (index === -1) {
    return null;
  }
  return { controllerKey: text.slice(0, index), action: text.slice(index + 1) };
}

interface ResolvedTarget {
  controllerKey: string;
  action: string;
  /**
   * Set for the `"path" => "controller#action"` form. Otherwise the path
   * comes from the call's first argument.
   */
  path: string | null;
}

function readRouteTarget(
  args: SimpleArgs,
  ctx: RouteContext,
): ResolvedTarget | null {
  const toText = textValue(args.keyword.to, ctx);
  if (toText !== null) {
    const target = splitControllerAction(toText);
    return target === null ? null : { ...target, path: null };
  }
  if (args.pair !== null) {
    const pathText = textValue(args.pair.key, ctx);
    const actionText = textValue(args.pair.value, ctx);
    const target =
      actionText !== null ? splitControllerAction(actionText) : null;
    return target !== null && pathText !== null
      ? { ...target, path: pathText }
      : null;
  }
  return null;
}

/**
 * The names a keyword such as `only:` lists. Rails takes each name as a
 * string, so `[:index, "show"]`, `%i[index show]`, `%w[index show]` and a
 * single `:index` all list names. Null when the keyword is not given, or
 * gives one value that is no name.
 */
function readNameList(
  value: ValueOps | undefined,
  ctx: RouteContext,
): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (writtenAsList(value)) {
    return value
      .items()
      .map((item) => textValue(item, ctx))
      .filter((name): name is string => name !== null);
  }
  const single = textValue(value, ctx);
  return single === null ? null : [single];
}

/** Rails routes `update` under both methods, PATCH first. */
const updateAt = (path: string): Route[] => [
  { method: "PATCH", path },
  { method: "PUT", path },
];

const RESTFUL_ROUTES_PLURAL: Record<string, (base: string) => Route[]> = {
  index: (base) => [{ method: "GET", path: base }],
  create: (base) => [{ method: "POST", path: base }],
  new: (base) => [{ method: "GET", path: `${base}/new` }],
  show: (base) => [{ method: "GET", path: `${base}/:id` }],
  edit: (base) => [{ method: "GET", path: `${base}/:id/edit` }],
  update: (base) => updateAt(`${base}/:id`),
  destroy: (base) => [{ method: "DELETE", path: `${base}/:id` }],
};

const RESTFUL_ROUTES_SINGULAR: Record<string, (base: string) => Route[]> = {
  create: (base) => [{ method: "POST", path: base }],
  new: (base) => [{ method: "GET", path: `${base}/new` }],
  show: (base) => [{ method: "GET", path: base }],
  edit: (base) => [{ method: "GET", path: `${base}/edit` }],
  update: (base) => updateAt(base),
  destroy: (base) => [{ method: "DELETE", path: base }],
};

/**
 * The routes `resources` gives one of Rails' seven actions under `base`,
 * such as `/orders`, or none for any other action.
 */
export function restfulRoutes(action: string, base: string): Route[] {
  if (!Object.hasOwn(RESTFUL_ROUTES_PLURAL, action)) {
    return [];
  }
  return RESTFUL_ROUTES_PLURAL[action]?.(base) ?? [];
}

/**
 * A small pluralizer that covers the regular names a routes file uses.
 * The README lists what it leaves out.
 */
function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  if (/(ss|us|is|x|z|ch|sh)$/.test(word)) {
    return `${word}es`;
  }
  // A name that already ends in `s` is left as it is, the way Rails
  // routes `resource :settings` to `SettingsController`.
  return /s$/.test(word) ? word : `${word}s`;
}

function singularize(word: string): string {
  if (/ies$/.test(word)) {
    return `${word.slice(0, -3)}y`;
  }
  if (/(ses|xes|zes|ches|shes)$/.test(word)) {
    return word.slice(0, -2);
  }
  return /s$/.test(word) ? word.slice(0, -1) : word;
}

/** An engine's own route set, walked under the path each `mount` gives it. */
interface EngineRouteSet {
  readonly modulePrefix: string;
  /** The calls in the block of the engine's `Name::Engine.routes.draw do ... end`, or null when its routes file draws none. */
  readonly body: readonly CallOps[] | null;
  /** The engine's routes file, as a gap message prints it. */
  readonly displayPath: string;
}

class RouteAccumulator {
  private readonly byKey = new Map<string, Route[]>();
  private readonly unread = new Map<string, Set<string>>();
  /** Per file, the gem block calls whose bodies were walked as if the call were not there. */
  private readonly walkedBlocks = new Map<string, Set<string>>();
  private readonly missingDrawn: { file: string; name: string }[] = [];
  /** The calls in each `concern :name do ... end` block, for `concerns` to replay. */
  readonly concerns = new Map<string, readonly CallOps[]>();
  /** Files `draw(:name)` has already read, so a file drawing itself stops. */
  readonly drawn = new Set<string>();
  /** Every engine a `mount` may refer to, keyed by class name. */
  readonly engines = new Map<string, EngineRouteSet>();
  /** Engines whose route set is being walked, so an engine that mounts itself stops. */
  readonly mounting = new Set<string>();
  /** The file whose statements are being walked, as a gap message prints it. */
  file = "";

  /** `drawDirectory` is where `draw(:name)` finds `name.rb`. */
  constructor(readonly drawDirectory: string) {}

  /** An action routed from several places serves every one of them, so each distinct route is kept. */
  add(controllerKey: string, action: string, route: Route): void {
    const key = `${controllerKey}#${action}`;
    const routes = this.byKey.get(key) ?? [];
    const path = pathWithOptionalGroups(route.path);
    if (
      !routes.some((one) => one.method === route.method && one.path === path)
    ) {
      routes.push({
        method: route.method,
        path,
        ...(route.formatless === true ? { formatless: true } : {}),
      });
    }
    this.byKey.set(key, routes);
  }

  recordUnread(callName: string): void {
    addUnderFile(this.unread, this.file, callName);
  }

  recordWalkedBlock(callName: string): void {
    addUnderFile(this.walkedBlocks, this.file, callName);
  }

  recordMissingDrawn(name: string): void {
    this.missingDrawn.push({ file: this.file, name });
  }

  routesFor(controllerKey: string, action: string): Route[] {
    return this.byKey.get(`${controllerKey}#${action}`) ?? [];
  }

  /** Runs `walk` with gaps attributed to `file`, then goes back to the file being walked before. */
  inFile(file: string, walk: () => void): void {
    const previous = this.file;
    this.file = file;
    walk();
    this.file = previous;
  }

  gaps(): string[] {
    const gaps: string[] = [];
    for (const [file, unread] of this.unread) {
      const names = [...unread].sort().join(", ");
      gaps.push(
        `${file} also declares ${names}, which this pack does not read; whatever those declarations route is missing from what suss reports`,
      );
    }
    for (const [file, walked] of this.walkedBlocks) {
      const names = [...walked].sort().join(", ");
      gaps.push(
        `${file} wraps routes in ${names}, which this pack does not know; it read the routes inside as though the wrapper changed nothing about their path or controller`,
      );
    }
    for (const { file, name } of this.missingDrawn) {
      gaps.push(
        `${file} draws ${name}, but there is no ${name}.rb under ${path.basename(this.drawDirectory)}/ beside it to read; whatever that file routes is missing from what suss reports`,
      );
    }
    return gaps;
  }
}

function addUnderFile(
  byFile: Map<string, Set<string>>,
  file: string,
  name: string,
): void {
  const names = byFile.get(file) ?? new Set<string>();
  names.add(name);
  byFile.set(file, names);
}

function joinKey(prefix: string, segment: string): string {
  return prefix === "" ? segment : `${prefix}/${segment}`;
}

/**
 * Rails writes every route with one leading slash and none trailing,
 * whether the file spelled a segment as `v1`, `/v1` or `v1/`.
 */
function joinPath(prefix: string, segment: string): string {
  const trimmed = segment.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = prefix.replace(/\/+$/, "");
  return trimmed === "" ? base || "/" : `${base}/${trimmed}`;
}

/** The calls the call's block writes as statements, or null when it has no block. */
function blockCalls(call: CallOps): readonly CallOps[] | null {
  const block = call.block?.() ?? null;
  return block === null ? null : (block.bodyCalls?.() ?? []);
}

function handleResourceCall(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
  plural: boolean,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const name = textValue(args.positional[0], ctx);
  if (name === null) {
    return;
  }
  // Rails routes a singular resource to the plural controller, and
  // `controller:` or `path:` overrides what the name would have given.
  // `module:` puts the controller under one more directory.
  const controllerSegment =
    textValue(args.keyword.controller, ctx) ??
    (plural ? name : pluralize(name));
  const moduleName = textValue(args.keyword.module, ctx);
  const modulePrefix =
    moduleName === null
      ? ctx.modulePrefix
      : joinKey(ctx.modulePrefix, moduleName);
  const controllerKey = joinKey(modulePrefix, controllerSegment);
  const prefixBase =
    ctx.resource !== undefined ? ctx.resource.nestedBase : ctx.pathPrefix;
  const base = joinPath(prefixBase, textValue(args.keyword.path, ctx) ?? name);

  const only = readNameList(args.keyword.only, ctx);
  const except = readNameList(args.keyword.except, ctx);
  const table = plural ? RESTFUL_ROUTES_PLURAL : RESTFUL_ROUTES_SINGULAR;
  for (const [action, routesAt] of Object.entries(table)) {
    if (only !== null && !only.includes(action)) {
      continue;
    }
    if (except?.includes(action)) {
      continue;
    }
    for (const route of routesAt(base)) {
      out.add(controllerKey, action, route);
    }
  }

  // Rails takes the nesting parameter from the resource's own name,
  // whatever `path:` said the URL reads.
  const nestedBase = plural ? `${base}/:${singularize(name)}_id` : base;
  const nested: ResourceScope = {
    controllerKey,
    collectionBase: base,
    memberBase: plural ? `${base}/:id` : base,
    nestedBase,
    ambientBase: nestedBase,
  };
  const inside: RouteContext = { ...ctx, modulePrefix, resource: nested };
  applyConcerns(readNameList(args.keyword.concerns, ctx) ?? [], inside, out);

  const body = blockCalls(call);
  if (body !== null) {
    walkCalls(body, inside, out);
  }
}

function handleOnBlock(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
  isMember: boolean,
): void {
  if (ctx.resource === undefined) {
    return;
  }
  const body = blockCalls(call);
  if (body === null) {
    return;
  }
  const ambientBase = isMember
    ? ctx.resource.memberBase
    : ctx.resource.collectionBase;
  walkCalls(body, { ...ctx, resource: { ...ctx.resource, ambientBase } }, out);
}

/** The base path for a bare verb inside a resource, given its `on:` keyword. */
function baseForOn(resource: ResourceScope, on: string | null): string {
  if (on === "collection") {
    return resource.collectionBase;
  }
  if (on === "member") {
    return resource.memberBase;
  }
  return resource.ambientBase;
}

function handleVerb(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
  method: string,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const on = textValue(args.keyword.on, ctx);
  // Inside a resource block, the path starts from the resource's base for
  // this `on:` value.
  const base =
    ctx.resource === undefined ? ctx.pathPrefix : baseForOn(ctx.resource, on);
  const target = readRouteTarget(args, ctx);
  const format = formatOf(args);
  if (target !== null) {
    const literalPath = textValue(args.positional[0], ctx);
    const path = target.path ?? literalPath;
    if (path !== null) {
      out.add(joinKey(ctx.modulePrefix, target.controllerKey), target.action, {
        method,
        path: joinPath(base, path),
        ...format,
      });
    }
    return;
  }

  const segment = textValue(args.positional[0], ctx);
  if (segment === null) {
    return;
  }
  // `post :recording, action: :start_recording` routes to the `action:`
  // keyword's action, at the path the first argument gives.
  const action = textValue(args.keyword.action, ctx) ?? actionFromPath(segment);
  const controller = textValue(args.keyword.controller, ctx);
  const controllerKey =
    controller !== null
      ? joinKey(ctx.modulePrefix, controller)
      : ctx.resource?.controllerKey;
  if (controllerKey === undefined || action === null) {
    return;
  }
  out.add(controllerKey, action, {
    method,
    path: joinPath(base, segment),
    ...format,
  });
}

/**
 * The action Rails takes from a bare verb's path when nothing else gives
 * one: the path itself when it is one word, with each `-` changed to `_`,
 * as ActionDispatch does. A path with any other character in it, a slash
 * or a parameter's colon, gives no action.
 */
function actionFromPath(segment: string): string | null {
  return /^[\w-]+$/.test(segment) ? segment.replaceAll("-", "_") : null;
}

/** `format: false` turns off the `.:format` Rails adds to a route. */
function formatOf(args: SimpleArgs): Pick<Route, "formatless"> {
  return args.keyword.format?.flag() === false ? { formatless: true } : {};
}

function handleRoot(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const target =
    readRouteTarget(args, ctx) ??
    (args.positional[0]
      ? splitControllerAction(textValue(args.positional[0], ctx) ?? "")
      : null);
  if (target !== null) {
    out.add(joinKey(ctx.modulePrefix, target.controllerKey), target.action, {
      method: "GET",
      path: ctx.pathPrefix === "" ? "/" : ctx.pathPrefix,
    });
  }
}

function handleNamespace(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const name = textValue(args.positional[0], ctx);
  const body = blockCalls(call);
  if (name === null || body === null) {
    return;
  }
  walkCalls(body, enterScope(ctx, name, name), out);
}

/**
 * The context a `namespace` or `scope` block walks under. Inside a
 * resource block the path continues from where a nested resource would
 * go, such as `/users/:user_id`. The resource itself is dropped, so a
 * bare verb inside the scope with no `controller:` is not read.
 */
function enterScope(
  ctx: RouteContext,
  pathSegment: string | null,
  moduleName: string | null,
): RouteContext {
  const base = ctx.resource?.nestedBase ?? ctx.pathPrefix;
  const { resource: _left, ...kept } = ctx;
  return {
    ...kept,
    pathPrefix: pathSegment !== null ? joinPath(base, pathSegment) : base,
    modulePrefix:
      moduleName !== null
        ? joinKey(ctx.modulePrefix, moduleName)
        : ctx.modulePrefix,
  };
}

function handleScope(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const moduleName = textValue(args.keyword.module, ctx);
  // `scope "v1"` and `scope path: "v1"` both set the path in Rails.
  const pathSegment =
    textValue(args.keyword.path, ctx) ?? textValue(args.positional[0], ctx);
  const body = blockCalls(call);
  if (body === null) {
    return;
  }
  walkCalls(body, enterScope(ctx, pathSegment, moduleName), out);
}

const LOOP_METHODS = new Set(["each", "each_with_index"]);

/**
 * `%w[users u].each do |root_path| ... end` declares its block once per
 * element, so the block is walked once per element with the variable
 * bound. A loop over anything but a list written out in place is
 * skipped, because its elements are unknown here.
 */
function replayLiteralLoop(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const loop = call.loopsOver?.() ?? null;
  const body = blockCalls(call);
  if (
    loop === null ||
    body === null ||
    !LOOP_METHODS.has(call.method() ?? "") ||
    !writtenAsList(loop.over)
  ) {
    return;
  }
  loop.over.items().forEach((item, position) => {
    const word = textValue(item, ctx);
    if (word === null) {
      return;
    }
    const bindings = new Map(ctx.bindings ?? []);
    bindings.set(loop.element, word);
    if (loop.position !== null) {
      bindings.set(loop.position, String(position));
    }
    walkCalls(body, { ...ctx, bindings }, out);
  });
}

/** A block whose calls route under the enclosing scope unchanged: `constraints` only narrows which requests match. */
function walkBlockInPlace(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const body = blockCalls(call);
  if (body !== null) {
    walkCalls(body, ctx, out);
  }
}

function handleWithOptions(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const body = blockCalls(call);
  if (body === null) {
    return;
  }
  walkCalls(body, { ...ctx, defaults: args.keyword }, out);
}

function handleConcern(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const name = textValue(args.positional[0], ctx);
  const body = blockCalls(call);
  if (name !== null && body !== null) {
    out.concerns.set(name, body);
  }
}

/** Replays each named concern's block where `concerns :a, :b` or `concerns: [:a, :b]` was written. */
function applyConcerns(
  names: readonly string[],
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  for (const name of names) {
    const body = out.concerns.get(name);
    if (body !== undefined) {
      walkCalls(body, ctx, out);
    }
  }
}

function handleConcerns(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const names = args.positional
    .map((value) => textValue(value, ctx))
    .filter((name): name is string => name !== null);
  applyConcerns(names, ctx, out);
}

/** The HTTP methods a `match ... via:` serves, `*` for `via: :all`. */
function methodsOfVia(
  value: ValueOps | undefined,
  ctx: RouteContext,
): string[] {
  const names = readNameList(value, ctx) ?? [];
  if (names.includes("all")) {
    return ["*"];
  }
  return names.map((name) => name.toUpperCase());
}

function handleMatch(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const via = readSimpleArgs(call, ctx.defaults).keyword.via;
  for (const method of methodsOfVia(via, ctx)) {
    handleVerb(call, ctx, out, method);
  }
}

/**
 * Where `draw(:name)` reads `name.rb` from: the directory beside the
 * routes file that shares its stem, so `config/routes/` for
 * `config/routes.rb`. Rails reads from the same directory.
 */
export function drawDirectoryOf(routesFile: string): string {
  return path.join(
    path.dirname(routesFile),
    path.basename(routesFile, path.extname(routesFile)),
  );
}

/** `draw(:name)` reads `name.rb` from the draw directory; its top-level calls route under the scope the draw was written in. */
function handleDraw(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const name = textValue(args.positional[0], ctx);
  if (name === null) {
    return;
  }
  const file = path.join(out.drawDirectory, `${name}.rb`);
  if (out.drawn.has(file)) {
    return;
  }
  out.drawn.add(file);
  if (!fs.existsSync(file)) {
    out.recordMissingDrawn(name);
    return;
  }
  walkCalls(moduleOpsForFile(file).bodyCalls(), ctx, out);
}

type CallHandler = (
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
) => void;

const HANDLERS: Record<string, CallHandler> = {
  resources: (call, ctx, out) => handleResourceCall(call, ctx, out, true),
  resource: (call, ctx, out) => handleResourceCall(call, ctx, out, false),
  member: (call, ctx, out) => handleOnBlock(call, ctx, out, true),
  collection: (call, ctx, out) => handleOnBlock(call, ctx, out, false),
  namespace: handleNamespace,
  scope: handleScope,
  root: handleRoot,
  get: (call, ctx, out) => handleVerb(call, ctx, out, "GET"),
  post: (call, ctx, out) => handleVerb(call, ctx, out, "POST"),
  patch: (call, ctx, out) => handleVerb(call, ctx, out, "PATCH"),
  put: (call, ctx, out) => handleVerb(call, ctx, out, "PUT"),
  delete: (call, ctx, out) => handleVerb(call, ctx, out, "DELETE"),
  match: handleMatch,
  draw: handleDraw,
  constraints: walkBlockInPlace,
  with_options: handleWithOptions,
  concern: handleConcern,
  concerns: handleConcerns,
  mount: handleMount,
};

/**
 * `mount Billing::Engine, at: "/billing"` serves the engine's route set
 * under that path. Its controllers are keyed under the engine's
 * namespace, whatever `module:` the mount is written inside. A mount of
 * anything other than a known engine, such as `Sidekiq::Web`, is
 * recorded as unread.
 */
function handleMount(
  call: CallOps,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const target = args.positional[0] ?? args.pair?.key;
  const at = args.keyword.at ?? args.pair?.value;
  const name = target?.source?.().replace(/^::/, "");
  const engine = name === undefined ? undefined : out.engines.get(name);
  const mountPath = textValue(at, ctx);
  if (
    name === undefined ||
    engine === undefined ||
    mountPath === null ||
    out.mounting.has(name)
  ) {
    out.recordUnread("mount");
    return;
  }
  const body = engine.body;
  if (body === null) {
    return;
  }
  out.mounting.add(name);
  out.inFile(engine.displayPath, () => {
    walkCalls(
      body,
      {
        pathPrefix: joinPath(ctx.pathPrefix, mountPath),
        modulePrefix: engine.modulePrefix,
        defaults: {},
      },
      out,
    );
  });
  out.mounting.delete(name);
}

/**
 * The name a call is matched against the handlers by: its method, or the
 * name it calls bare, which the facts give no method for.
 */
function nameOf(call: CallOps): string {
  return call.method() ?? call.calleeText();
}

/** Whether the call is written on a receiver, which a bare routing call never is. */
function hasReceiver(call: CallOps): boolean {
  return call.calleeText() !== nameOf(call);
}

/**
 * Walks the calls a block or a file writes as statements, which the ops
 * list through the branches of any `if`, `unless`, `case` or `begin`
 * among them, so a route under `if Rails.env.development?` is declared
 * in the same scope as one written outside it.
 */
function walkCalls(
  calls: readonly CallOps[],
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  for (const call of calls) {
    if (hasReceiver(call)) {
      replayLiteralLoop(call, ctx, out);
      continue;
    }
    const name = nameOf(call);
    const handler = HANDLERS[name];
    if (handler !== undefined) {
      handler(call, ctx, out);
      continue;
    }
    if (blockWrittenInRoutesGrammar(call)) {
      out.recordWalkedBlock(name);
      walkBlockInPlace(call, ctx, out);
      continue;
    }
    out.recordUnread(name);
  }
}

/**
 * A gem's block call, such as `devise_scope :user do ... end`, wraps
 * routes in the ordinary grammar and leaves their path and controller
 * alone. A block with no routing call, such as `direct`, stays unread.
 */
function blockWrittenInRoutesGrammar(call: CallOps): boolean {
  return (blockCalls(call) ?? []).some(
    (statement) =>
      !hasReceiver(statement) && Object.hasOwn(HANDLERS, nameOf(statement)),
  );
}

type DeclarationKind = "prepend" | "draw" | "append";

/**
 * Rails runs every `prepend` block first, then each `draw`, then every
 * `append`.
 */
const DECLARATION_ORDER: Record<DeclarationKind, number> = {
  prepend: 0,
  draw: 1,
  append: 2,
};

function isDeclarationKind(name: string): name is DeclarationKind {
  return name in DECLARATION_ORDER;
}

interface RouteDeclaration {
  /** What the block adds routes to, as written before `.routes`: `Rails.application`, `Shop::Application` or `Billing::Engine`. */
  readonly owner: string;
  readonly kind: DeclarationKind;
  readonly body: readonly CallOps[];
  readonly displayPath: string;
}

/**
 * Every `<owner>.routes.draw|prepend|append do ... end` the file writes
 * outside a method: among the calls of its body, or among the calls a
 * block outside a method writes as statements, however deep.
 */
function routeDeclarations(
  module: ModuleOps,
  displayPath: string,
): RouteDeclaration[] {
  const found: RouteDeclaration[] = [];
  const visit = (call: CallOps): void => {
    const declaration = asRouteDeclaration(call, displayPath);
    if (declaration !== null) {
      found.push(declaration);
      return;
    }
    for (const inner of blockCalls(call) ?? []) {
      visit(inner);
    }
  };
  for (const call of module.calls()) {
    visit(call);
  }
  return found;
}

/** How the call a declaration is made on ends: `Rails.application.routes`. */
const ROUTES_READ = ".routes";

function asRouteDeclaration(
  call: CallOps,
  displayPath: string,
): RouteDeclaration | null {
  const kind = call.method();
  const routes = call.receiver();
  const body = blockCalls(call);
  const written = routes?.calleeText() ?? "";
  if (
    kind === null ||
    !isDeclarationKind(kind) ||
    routes?.method() !== "routes" ||
    !written.endsWith(ROUTES_READ) ||
    body === null
  ) {
    return null;
  }
  const owner = written.slice(0, -ROUTES_READ.length).replace(/^::/, "");
  return { owner, kind, body, displayPath };
}

/** `Rails.application` and the `Shop::Application` class Rails generates are the same route set, the app's own. */
function isApplication(owner: string): boolean {
  return owner === "Rails.application" || /(^|::)Application$/.test(owner);
}

/** A routes file to read, with the path a gap message prints for it. */
export interface RoutesSource {
  readonly file: string;
  readonly displayPath: string;
}

export interface RoutesInput {
  /** The app's own routes file. When it is missing, no routing is read. */
  readonly routesFile: RoutesSource;
  /** Engines a `mount` may refer to, each with its own routes file to read the engine's route set from. */
  readonly engines: readonly (RailsEngine & { readonly displayPath: string })[];
  /** Files beyond the routes file that add routes, by a `routes.draw`, `routes.append` or `routes.prepend` block written anywhere in them. */
  readonly routesFiles: readonly RoutesSource[];
}

function parseDeclarations(source: RoutesSource): RouteDeclaration[] {
  if (!fs.existsSync(source.file)) {
    return [];
  }
  return routeDeclarations(moduleOpsForFile(source.file), source.displayPath);
}

/**
 * Reads the app's routes file, every engine's, and any other file that
 * adds routes, into one table keyed by controller routing key. An
 * engine's `Name::Engine.routes.draw` block is set aside and walked
 * under the path each `mount Name::Engine, at:` gives it. Every other
 * declaration adds to the app's route set, in the order Rails runs them.
 */
export function readRoutes(input: RoutesInput): RouteTable {
  if (!fs.existsSync(input.routesFile.file)) {
    return {
      routesFor: () => [],
      fileFound: false,
      gaps: [
        `${input.routesFile.displayPath} does not exist, so this run assumes each action's path and method from Rails' RESTful naming convention instead of reading it from routing`,
      ],
    };
  }
  const out = new RouteAccumulator(drawDirectoryOf(input.routesFile.file));
  const engineDeclarations = input.engines.flatMap((engine) =>
    engine.routesFile === null
      ? []
      : parseDeclarations({
          file: engine.routesFile,
          displayPath: engine.displayPath,
        }),
  );
  for (const engine of input.engines) {
    out.engines.set(engine.qualifiedName, {
      modulePrefix: engine.modulePrefix,
      body:
        engineDeclarations.find(
          (declaration) => declaration.owner === engine.qualifiedName,
        )?.body ?? null,
      displayPath: engine.displayPath,
    });
  }
  const applicationDeclarations = [
    ...parseDeclarations(input.routesFile),
    ...input.routesFiles.flatMap(parseDeclarations),
    ...engineDeclarations,
  ].filter((declaration) => isApplication(declaration.owner));
  const ordered = applicationDeclarations
    .map((declaration, position) => ({ declaration, position }))
    .sort(
      (a, b) =>
        DECLARATION_ORDER[a.declaration.kind] -
          DECLARATION_ORDER[b.declaration.kind] || a.position - b.position,
    );
  for (const { declaration } of ordered) {
    out.inFile(declaration.displayPath, () => {
      walkCalls(
        declaration.body,
        { pathPrefix: "", modulePrefix: "", defaults: {} },
        out,
      );
    });
  }
  return {
    routesFor: (controllerKey, action) => out.routesFor(controllerKey, action),
    fileFound: true,
    gaps: out.gaps(),
  };
}
