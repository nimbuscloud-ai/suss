/**
 * Reads `config/routes.rb`, or whatever file a project points this
 * pack at, into a table of controller action -> HTTP method and path.
 *
 * The grammar read here is bounded on purpose: `resources`/`resource`
 * with `only:`/`except:`, `member`/`collection` blocks, nested
 * resources, `namespace`, `scope`, the bare HTTP-verb methods and
 * `match ... via:`, `root`, `draw(:name)`, `constraints` and
 * `with_options` blocks, `concern`/`concerns`, `.each` over a literal
 * list, `mount` of an engine the project keeps in its own tree, and a
 * gem's block call whose body is written in that grammar. Anything
 * else, `direct` and a gem's own routing call among them, is left
 * unread and reported once as a gap. The README says why each stops.
 */

import fs from "node:fs";
import path from "node:path";

import {
  bodyStatements,
  field,
  hashKeySymbolName,
  parseRubySync,
  stringValueOf,
  symbolValue,
} from "@suss/adapter-ruby";

import type { ParameterBindings, RbNode } from "@suss/adapter-ruby";
import type { RailsEngine } from "./engines.js";

export interface Route {
  method: string;
  path: string;
}

export interface RouteTable {
  /** The method and path this reading gives one controller's action, keyed the way `config/routes.rb` itself keys a controller: lowercase, slash-joined, `admin/orders` for `namespace :admin do resources :orders end`. Null when this reading found no route for it. */
  routeFor(controllerKey: string, actionName: string): Route | null;
  /** One message per routing declaration kind this reading left uncovered, or because the file was not there at all. */
  readonly gaps: readonly string[];
  /** False when there was no file at the path this run was given, the one case a caller falls back to a naming convention instead of `routeFor`. */
  readonly fileFound: boolean;
}

interface ResourceScope {
  controllerKey: string;
  collectionBase: string;
  memberBase: string;
  /**
   * The prefix a resource nested one level inside this one is written
   * under: `/orders/:order_id` for a plural resource, and the
   * resource's own path for a singular one, which has no id to key on.
   */
  nestedBase: string;
  /** Which base a bare verb call with no `on:` uses: `nestedBase` directly inside a resource block, and the member or collection base inside a `member` or `collection` block. */
  ambientBase: string;
}

interface RouteContext {
  pathPrefix: string;
  modulePrefix: string;
  resource?: ResourceScope;
  /** Keywords an enclosing `with_options` gives every call inside it; a call's own keyword wins. */
  defaults: Record<string, RbNode>;
  /** The element an enclosing `%w[a b].each do |name|` is replaying its block for, so a string that reads `name` comes out spelled. */
  bindings?: ParameterBindings;
}

interface SimpleArgs {
  positional: RbNode[];
  keyword: Record<string, RbNode>;
  /** The one `"key" => value` pair a call argument list can carry, tree-sitter's shape for a bare hash literal argument written with the hash-rocket operator instead of a `key:` shorthand. */
  hashRocketPair: { key: RbNode; value: RbNode } | null;
}

function readSimpleArgs(
  call: RbNode,
  defaults: Record<string, RbNode> = {},
): SimpleArgs {
  const argumentList = field(call, "arguments");
  const positional: RbNode[] = [];
  const keyword: Record<string, RbNode> = { ...defaults };
  let hashRocketPair: SimpleArgs["hashRocketPair"] = null;
  if (argumentList === null) {
    return { positional, keyword, hashRocketPair };
  }
  for (const child of bodyStatements(argumentList)) {
    if (child.type !== "pair") {
      positional.push(child);
      continue;
    }
    const keyNode = field(child, "key");
    const valueNode = field(child, "value");
    if (keyNode === null || valueNode === null) {
      continue;
    }
    // `constraints: x` and `:constraints => x` are the same keyword.
    const symbolKey = hashKeySymbolName(keyNode) ?? symbolValue(keyNode);
    if (symbolKey !== null) {
      keyword[symbolKey] = valueNode;
    } else {
      hashRocketPair = { key: keyNode, value: valueNode };
    }
  }
  return { positional, keyword, hashRocketPair };
}

/** The one string `node` spells, with the loop element an enclosing `.each` bound. */
function textValue(node: RbNode, ctx: RouteContext): string | null {
  return stringValueOf(node, undefined, ctx.bindings);
}

/** A keyword's value read as a plain word, written either as a symbol or as a string. */
function wordValue(node: RbNode | undefined, ctx: RouteContext): string | null {
  if (node === undefined) {
    return null;
  }
  return symbolValue(node) ?? textValue(node, ctx);
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
  /** Set when the path came bundled with the target, the `"path" => "controller#action"` spelling; read from the call's own first argument otherwise. */
  path: string | null;
}

function readRouteTarget(
  args: SimpleArgs,
  ctx: RouteContext,
): ResolvedTarget | null {
  const toText = args.keyword.to ? textValue(args.keyword.to, ctx) : null;
  if (toText !== null) {
    const target = splitControllerAction(toText);
    return target === null ? null : { ...target, path: null };
  }
  if (args.hashRocketPair !== null) {
    const pathText = textValue(args.hashRocketPair.key, ctx);
    const actionText = textValue(args.hashRocketPair.value, ctx);
    const target =
      actionText !== null ? splitControllerAction(actionText) : null;
    return target !== null && pathText !== null
      ? { ...target, path: pathText }
      : null;
  }
  return null;
}

function readSymbolList(node: RbNode | undefined): string[] | null {
  if (node === undefined) {
    return null;
  }
  if (node.type === "array") {
    return bodyStatements(node)
      .map((child) => symbolValue(child))
      .filter((name): name is string => name !== null);
  }
  const single = symbolValue(node);
  return single === null ? null : [single];
}

const RESTFUL_ROUTES_PLURAL: Record<string, (base: string) => Route> = {
  index: (base) => ({ method: "GET", path: base }),
  create: (base) => ({ method: "POST", path: base }),
  new: (base) => ({ method: "GET", path: `${base}/new` }),
  show: (base) => ({ method: "GET", path: `${base}/:id` }),
  edit: (base) => ({ method: "GET", path: `${base}/:id/edit` }),
  update: (base) => ({ method: "PATCH", path: `${base}/:id` }),
  destroy: (base) => ({ method: "DELETE", path: `${base}/:id` }),
};

const RESTFUL_ROUTES_SINGULAR: Record<string, (base: string) => Route> = {
  create: (base) => ({ method: "POST", path: base }),
  new: (base) => ({ method: "GET", path: `${base}/new` }),
  show: (base) => ({ method: "GET", path: base }),
  edit: (base) => ({ method: "GET", path: `${base}/edit` }),
  update: (base) => ({ method: "PATCH", path: base }),
  destroy: (base) => ({ method: "DELETE", path: base }),
};

/** Naive English pluralization, enough to round-trip the resource names a project actually spells in its own routes file. */
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
  /** The block of the engine's `Name::Engine.routes.draw do ... end`, or null when its routes file draws none. */
  readonly body: RbNode | null;
  /** The engine's routes file as written into a gap. */
  readonly displayPath: string;
}

class RouteAccumulator {
  private readonly byKey = new Map<string, Route>();
  private readonly unread = new Map<string, Set<string>>();
  /** Per file, each gem block call whose body was walked as though the call changed nothing about it. */
  private readonly walkedBlocks = new Map<string, Set<string>>();
  private readonly missingDrawn: { file: string; name: string }[] = [];
  /** The block each `concern :name do ... end` declared, for `concerns` to replay. */
  readonly concerns = new Map<string, RbNode>();
  /** Files `draw(:name)` has already read, so a file drawing itself stops. */
  readonly drawn = new Set<string>();
  /** Every engine a `mount` may refer to, by the class name it is written with. */
  readonly engines = new Map<string, EngineRouteSet>();
  /** Engines whose route set is being walked, so an engine that mounts itself stops. */
  readonly mounting = new Set<string>();
  /** The file whose statements are being walked, as a gap writes it. */
  file = "";

  /** `drawDirectory` is where `draw(:name)` finds `name.rb`. */
  constructor(readonly drawDirectory: string) {}

  /** The first route written for an action wins, the way Rails matches the first route it declared. */
  add(controllerKey: string, action: string, route: Route): void {
    const key = `${controllerKey}#${action}`;
    if (!this.byKey.has(key)) {
      this.byKey.set(key, route);
    }
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

  routeFor(controllerKey: string, action: string): Route | null {
    return this.byKey.get(`${controllerKey}#${action}`) ?? null;
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

function handleResourceCall(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
  plural: boolean,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const symbol = args.positional[0] ? symbolValue(args.positional[0]) : null;
  if (symbol === null) {
    return;
  }
  // Rails routes a singular resource to the plural controller, and
  // `controller:` or `path:` overrides what the name would have given.
  // `module:` puts the controller under one more directory.
  const controllerSegment =
    wordValue(args.keyword.controller, ctx) ??
    (plural ? symbol : pluralize(symbol));
  const moduleName = wordValue(args.keyword.module, ctx);
  const modulePrefix =
    moduleName === null
      ? ctx.modulePrefix
      : joinKey(ctx.modulePrefix, moduleName);
  const controllerKey = joinKey(modulePrefix, controllerSegment);
  const prefixBase =
    ctx.resource !== undefined ? ctx.resource.nestedBase : ctx.pathPrefix;
  const base = joinPath(
    prefixBase,
    wordValue(args.keyword.path, ctx) ?? symbol,
  );

  const only = readSymbolList(args.keyword.only);
  const except = readSymbolList(args.keyword.except);
  const table = plural ? RESTFUL_ROUTES_PLURAL : RESTFUL_ROUTES_SINGULAR;
  for (const [action, routeAt] of Object.entries(table)) {
    if (only !== null && !only.includes(action)) {
      continue;
    }
    if (except?.includes(action)) {
      continue;
    }
    out.add(controllerKey, action, routeAt(base));
  }

  // Rails takes the nesting parameter from the resource's own name,
  // whatever `path:` said the URL reads.
  const nestedBase = plural ? `${base}/:${singularize(symbol)}_id` : base;
  const nested: ResourceScope = {
    controllerKey,
    collectionBase: base,
    memberBase: plural ? `${base}/:id` : base,
    nestedBase,
    ambientBase: nestedBase,
  };
  const inside: RouteContext = { ...ctx, modulePrefix, resource: nested };
  applyConcerns(readSymbolList(args.keyword.concerns) ?? [], inside, out);

  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body !== null) {
    walkBody(body, inside, out);
  }
}

function handleOnBlock(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
  isMember: boolean,
): void {
  if (ctx.resource === undefined) {
    return;
  }
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return;
  }
  const ambientBase = isMember
    ? ctx.resource.memberBase
    : ctx.resource.collectionBase;
  walkBody(body, { ...ctx, resource: { ...ctx.resource, ambientBase } }, out);
}

/** Where a bare verb inside a resource scope hangs its path, given what `on:` said. */
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
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
  method: string,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const on = wordValue(args.keyword.on, ctx);
  // Inside a resource block the path continues from the resource, the
  // same place a bare verb hangs its own.
  const base =
    ctx.resource === undefined ? ctx.pathPrefix : baseForOn(ctx.resource, on);
  const target = readRouteTarget(args, ctx);
  if (target !== null) {
    const literalPath = args.positional[0]
      ? textValue(args.positional[0], ctx)
      : null;
    const path = target.path ?? literalPath;
    if (path !== null) {
      out.add(joinKey(ctx.modulePrefix, target.controllerKey), target.action, {
        method,
        path: joinPath(base, path),
      });
    }
    return;
  }

  const segment = args.positional[0]
    ? wordValue(args.positional[0], ctx)
    : null;
  if (segment === null) {
    return;
  }
  // `post :recording, action: :start_recording` serves the action named
  // by the keyword at the path the first argument spells.
  const action = wordValue(args.keyword.action, ctx) ?? segment;
  const controller = wordValue(args.keyword.controller, ctx);
  const controllerKey =
    controller !== null
      ? joinKey(ctx.modulePrefix, controller)
      : ctx.resource?.controllerKey;
  if (controllerKey === undefined) {
    return;
  }
  out.add(controllerKey, action, { method, path: joinPath(base, segment) });
}

function handleRoot(
  call: RbNode,
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
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const symbol = args.positional[0] ? symbolValue(args.positional[0]) : null;
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (symbol === null || body === null) {
    return;
  }
  walkBody(body, enterScope(ctx, symbol, symbol), out);
}

/**
 * The context a `namespace` or `scope` block walks under. Inside a
 * resource block the path continues from where a nested resource would
 * go, `/users/:user_id`, and the resource itself is left behind, so a
 * bare verb inside the scope is unread rather than guessed at.
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
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const moduleName = wordValue(args.keyword.module, ctx);
  // `scope "v1"` and `scope path: "v1"` both set the path in Rails.
  const pathSegment =
    wordValue(args.keyword.path, ctx) ??
    (args.positional[0] ? wordValue(args.positional[0], ctx) : null);
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return;
  }
  walkBody(body, enterScope(ctx, pathSegment, moduleName), out);
}

const LITERAL_LIST_TYPES = new Set(["array", "string_array", "symbol_array"]);
const LOOP_METHODS = new Set(["each", "each_with_index"]);

/** `%w[users u].each do |root_path| ... end` declares its block once per element, so it is walked once per element with the parameter bound. A loop over anything else is left alone, since nothing here can say what it iterates. */
function replayLiteralLoop(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text;
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  const parameters = block !== null ? field(block, "parameters") : null;
  if (
    receiver === null ||
    !LITERAL_LIST_TYPES.has(receiver.type) ||
    method === undefined ||
    !LOOP_METHODS.has(method) ||
    body === null ||
    parameters === null
  ) {
    return;
  }
  const [element, index] = bodyStatements(parameters).map((p) => p.text);
  if (element === undefined) {
    return;
  }
  const elements = bodyStatements(receiver).map((node) =>
    listElementWord(node, ctx),
  );
  elements.forEach((word, position) => {
    if (word === null) {
      return;
    }
    const bindings = new Map(ctx.bindings ?? []);
    bindings.set(element, word);
    if (index !== undefined) {
      bindings.set(index, String(position));
    }
    walkBody(body, { ...ctx, bindings }, out);
  });
}

/** One element of a literal list as a word: `%i[a]` spells a bare symbol, `[:a]` a symbol, `%w[a]` and `["a"]` a string. */
function listElementWord(node: RbNode, ctx: RouteContext): string | null {
  if (node.type === "bare_symbol") {
    return node.text;
  }
  return wordValue(node, ctx);
}

/** A block whose calls route under the enclosing scope unchanged: `constraints` only narrows which requests match. */
function walkBlockInPlace(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body !== null) {
    walkBody(body, ctx, out);
  }
}

function handleWithOptions(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return;
  }
  walkBody(body, { ...ctx, defaults: args.keyword }, out);
}

function handleConcern(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const name = args.positional[0] ? symbolValue(args.positional[0]) : null;
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
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
      walkBody(body, ctx, out);
    }
  }
}

function handleConcerns(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const names = args.positional
    .map((node) => symbolValue(node))
    .filter((name): name is string => name !== null);
  applyConcerns(names, ctx, out);
}

/** The HTTP methods a `match ... via:` serves, `*` for `via: :all`. */
function methodsOfVia(node: RbNode | undefined): string[] {
  const names = readSymbolList(node) ?? [];
  if (names.includes("all")) {
    return ["*"];
  }
  return names.map((name) => name.toUpperCase());
}

function handleMatch(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const via = readSimpleArgs(call, ctx.defaults).keyword.via;
  for (const method of methodsOfVia(via)) {
    handleVerb(call, ctx, out, method);
  }
}

/**
 * Where `draw(:name)` reads `name.rb` from: the directory beside the
 * routes file that shares its stem, `config/routes/` for
 * `config/routes.rb`, which is where Rails reads it from too.
 */
export function drawDirectoryOf(routesFile: string): string {
  return path.join(
    path.dirname(routesFile),
    path.basename(routesFile, path.extname(routesFile)),
  );
}

/** `draw(:name)` reads `name.rb` from the draw directory; its top-level calls route under the scope the draw was written in. */
function handleDraw(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const name = args.positional[0] ? wordValue(args.positional[0], ctx) : null;
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
  const tree = parseRubySync(fs.readFileSync(file, "utf8"));
  walkBody(tree.rootNode, ctx, out);
}

type StatementHandler = (
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
) => void;

const HANDLERS: Record<string, StatementHandler> = {
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
 * `mount Billing::Engine, at: "/billing"` serves the engine's own route
 * set under that path, its controllers keyed under the engine's
 * namespace whatever module the mount was written in. A mount of
 * anything but an engine this run knows, a gem's `Sidekiq::Web` say,
 * is recorded as unread.
 */
function handleMount(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const target = args.positional[0] ?? args.hashRocketPair?.key;
  const at = args.keyword.at ?? args.hashRocketPair?.value;
  const name = target?.text.replace(/^::/, "");
  const engine = name === undefined ? undefined : out.engines.get(name);
  const mountPath = at === undefined ? null : textValue(at, ctx);
  if (
    name === undefined ||
    engine === undefined ||
    mountPath === null ||
    out.mounting.has(name)
  ) {
    out.recordUnread("mount");
    return;
  }
  if (engine.body === null) {
    return;
  }
  out.mounting.add(name);
  out.inFile(engine.displayPath, () => {
    walkBody(
      engine.body as RbNode,
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

function walkBody(
  body: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  for (const statement of bodyStatements(body)) {
    if (statement.type !== "call") {
      continue;
    }
    if (field(statement, "receiver") !== null) {
      replayLiteralLoop(statement, ctx, out);
      continue;
    }
    const name = field(statement, "method")?.text;
    if (name === undefined) {
      continue;
    }
    const handler = HANDLERS[name];
    if (handler !== undefined) {
      handler(statement, ctx, out);
      continue;
    }
    if (blockWrittenInRoutesGrammar(statement)) {
      out.recordWalkedBlock(name);
      walkBlockInPlace(statement, ctx, out);
      continue;
    }
    out.recordUnread(name);
  }
}

/**
 * A gem's own block call, `devise_scope :user do ... end` or
 * `authenticated :admin do ... end`, wraps routes written in the
 * ordinary grammar and, in every gem read so far, leaves their path
 * and controller alone. One whose block is something else, a `direct`
 * building a URL say, stays unread with the call's own name.
 */
function blockWrittenInRoutesGrammar(call: RbNode): boolean {
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return false;
  }
  return bodyStatements(body).some(
    (statement) =>
      statement.type === "call" &&
      field(statement, "receiver") === null &&
      Object.hasOwn(HANDLERS, field(statement, "method")?.text ?? ""),
  );
}

type DeclarationKind = "prepend" | "draw" | "append";

/** The calls that add routes to a route set, in the order Rails runs them: every `prepend` block first, then each `draw`, then every `append`. */
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
  readonly body: RbNode;
  readonly displayPath: string;
}

/** Every `<owner>.routes.draw|prepend|append do ... end` written anywhere in the file, however deep. */
function routeDeclarations(
  root: RbNode,
  displayPath: string,
): RouteDeclaration[] {
  const found: RouteDeclaration[] = [];
  const visit = (node: RbNode): void => {
    const declaration = asRouteDeclaration(node, displayPath);
    if (declaration !== null) {
      found.push(declaration);
      return;
    }
    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

function asRouteDeclaration(
  node: RbNode,
  displayPath: string,
): RouteDeclaration | null {
  if (node.type !== "call") {
    return null;
  }
  const kind = field(node, "method")?.text;
  const receiver = field(node, "receiver");
  const block = field(node, "block");
  const body = block !== null ? field(block, "body") : null;
  if (
    kind === undefined ||
    !isDeclarationKind(kind) ||
    receiver === null ||
    receiver.type !== "call" ||
    field(receiver, "method")?.text !== "routes" ||
    body === null
  ) {
    return null;
  }
  const owner = field(receiver, "receiver");
  if (owner === null) {
    return null;
  }
  return { owner: owner.text.replace(/^::/, ""), kind, body, displayPath };
}

/** `Rails.application` and the `Shop::Application` class Rails generates are the same route set, the app's own. */
function isApplication(owner: string): boolean {
  return owner === "Rails.application" || /(^|::)Application$/.test(owner);
}

/** A routes file to read, with the path a gap writes it under. */
export interface RoutesSource {
  readonly file: string;
  readonly displayPath: string;
}

export interface RoutesInput {
  /** The app's own routes file, which decides whether routing is read at all. */
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
  const tree = parseRubySync(fs.readFileSync(source.file, "utf8"));
  return routeDeclarations(tree.rootNode, source.displayPath);
}

/**
 * Reads the app's routes file, every engine's, and any other file that
 * adds routes, into one table keyed the way routing keys a controller.
 * An engine's own `Name::Engine.routes.draw` block is kept aside and
 * walked under the path each `mount Name::Engine, at:` gives it; every
 * other declaration adds to the app's route set, in the order Rails
 * runs them.
 */
export function readRoutes(input: RoutesInput): RouteTable {
  if (!fs.existsSync(input.routesFile.file)) {
    return {
      routeFor: () => null,
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
      walkBody(
        declaration.body,
        { pathPrefix: "", modulePrefix: "", defaults: {} },
        out,
      );
    });
  }
  return {
    routeFor: (controllerKey, action) => out.routeFor(controllerKey, action),
    fileFound: true,
    gaps: out.gaps(),
  };
}
