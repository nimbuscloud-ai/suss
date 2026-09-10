/**
 * Reads `config/routes.rb`, or whatever file a project points this
 * pack at, into a table of controller action -> HTTP method and path.
 *
 * The grammar read here is bounded on purpose: `resources`/`resource`
 * with `only:`/`except:`, `member`/`collection` blocks, nested
 * resources, `namespace`, `scope`, the bare HTTP-verb methods and
 * `match ... via:`, `root`, `draw(:name)` for a file under
 * `config/routes/`, `constraints` and `with_options` blocks, and
 * `concern`/`concerns`. Anything else the file declares, `mount` and
 * `direct` among them, is left unread and reported once as a gap
 * rather than guessed at. The package README says why each stops here.
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

import type { RbNode } from "@suss/adapter-ruby";

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

/** A keyword's value read as a plain word, written either as a symbol or as a string. */
function wordValue(node: RbNode | undefined): string | null {
  if (node === undefined) {
    return null;
  }
  return symbolValue(node) ?? stringValueOf(node);
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

function readRouteTarget(args: SimpleArgs): ResolvedTarget | null {
  const toText = args.keyword.to ? stringValueOf(args.keyword.to) : null;
  if (toText !== null) {
    const target = splitControllerAction(toText);
    return target === null ? null : { ...target, path: null };
  }
  if (args.hashRocketPair !== null) {
    const pathText = stringValueOf(args.hashRocketPair.key);
    const actionText = stringValueOf(args.hashRocketPair.value);
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

class RouteAccumulator {
  private readonly byKey = new Map<string, Route>();
  private readonly unread = new Set<string>();
  private readonly missingDrawn: string[] = [];
  /** The block each `concern :name do ... end` declared, for `concerns` to replay. */
  readonly concerns = new Map<string, RbNode>();
  /** Files `draw(:name)` has already read, so a file drawing itself stops. */
  readonly drawn = new Set<string>();

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
    this.unread.add(callName);
  }

  recordMissingDrawn(name: string): void {
    this.missingDrawn.push(name);
  }

  routeFor(controllerKey: string, action: string): Route | null {
    return this.byKey.get(`${controllerKey}#${action}`) ?? null;
  }

  gapsAgainst(displayPath: string): string[] {
    const gaps: string[] = [];
    if (this.unread.size > 0) {
      const names = [...this.unread].sort().join(", ");
      gaps.push(
        `${displayPath} also declares ${names}, which this pack does not read; whatever those declarations route is missing from what suss reports`,
      );
    }
    for (const name of this.missingDrawn) {
      gaps.push(
        `${displayPath} draws ${name}, but there is no ${name}.rb under ${path.basename(this.drawDirectory)}/ beside it to read; whatever that file routes is missing from what suss reports`,
      );
    }
    return gaps;
  }
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
    wordValue(args.keyword.controller) ?? (plural ? symbol : pluralize(symbol));
  const moduleName = wordValue(args.keyword.module);
  const modulePrefix =
    moduleName === null
      ? ctx.modulePrefix
      : joinKey(ctx.modulePrefix, moduleName);
  const controllerKey = joinKey(modulePrefix, controllerSegment);
  const prefixBase =
    ctx.resource !== undefined ? ctx.resource.nestedBase : ctx.pathPrefix;
  const base = joinPath(prefixBase, wordValue(args.keyword.path) ?? symbol);

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
  const on = wordValue(args.keyword.on);
  // Inside a resource block the path continues from the resource, the
  // same place a bare verb hangs its own.
  const base =
    ctx.resource === undefined ? ctx.pathPrefix : baseForOn(ctx.resource, on);
  const target = readRouteTarget(args);
  if (target !== null) {
    const literalPath = args.positional[0]
      ? stringValueOf(args.positional[0])
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

  if (ctx.resource === undefined) {
    return;
  }
  const action = args.positional[0] ? wordValue(args.positional[0]) : null;
  if (action === null) {
    return;
  }
  out.add(ctx.resource.controllerKey, action, {
    method,
    path: `${base}/${action}`,
  });
}

function handleRoot(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const target =
    readRouteTarget(args) ??
    (args.positional[0]
      ? splitControllerAction(stringValueOf(args.positional[0]) ?? "")
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
  return {
    pathPrefix: pathSegment !== null ? joinPath(base, pathSegment) : base,
    modulePrefix:
      moduleName !== null
        ? joinKey(ctx.modulePrefix, moduleName)
        : ctx.modulePrefix,
    defaults: ctx.defaults,
  };
}

function handleScope(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call, ctx.defaults);
  const moduleName = wordValue(args.keyword.module);
  // `scope "v1"` and `scope path: "v1"` both set the path in Rails.
  const pathSegment =
    wordValue(args.keyword.path) ??
    (args.positional[0] ? wordValue(args.positional[0]) : null);
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return;
  }
  walkBody(body, enterScope(ctx, pathSegment, moduleName), out);
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
  const name = args.positional[0] ? wordValue(args.positional[0]) : null;
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
};

function walkBody(
  body: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  for (const statement of bodyStatements(body)) {
    if (statement.type !== "call" || field(statement, "receiver") !== null) {
      continue;
    }
    const name = field(statement, "method")?.text;
    if (name === undefined) {
      continue;
    }
    const handler = HANDLERS[name];
    if (handler === undefined) {
      out.recordUnread(name);
      continue;
    }
    handler(statement, ctx, out);
  }
}

/** The block body of the file's own `Rails.application.routes.draw do ... end` wrapper: the first top-level call carrying a block, whatever its receiver chain is spelled. */
function drawBlockBody(root: RbNode): RbNode | null {
  for (const statement of bodyStatements(root)) {
    if (statement.type !== "call") {
      continue;
    }
    const block = field(statement, "block");
    const body = block !== null ? field(block, "body") : null;
    if (body !== null) {
      return body;
    }
  }
  return null;
}

/**
 * Reads `absRoutesPath` with the grammar above. `displayPath` is the
 * same file's own path, written into the one gap this reading may
 * report; the table itself is keyed the way routing keys a
 * controller, independent of where the file that declared it lives.
 */
export function readRoutesFile(
  absRoutesPath: string,
  displayPath: string,
): RouteTable {
  if (!fs.existsSync(absRoutesPath)) {
    return {
      routeFor: () => null,
      fileFound: false,
      gaps: [
        `${displayPath} does not exist, so this run assumes each action's path and method from Rails' RESTful naming convention instead of reading it from routing`,
      ],
    };
  }
  const source = fs.readFileSync(absRoutesPath, "utf8");
  const tree = parseRubySync(source);
  const out = new RouteAccumulator(drawDirectoryOf(absRoutesPath));
  const body = drawBlockBody(tree.rootNode);
  if (body !== null) {
    walkBody(body, { pathPrefix: "", modulePrefix: "", defaults: {} }, out);
  }
  return {
    routeFor: (controllerKey, action) => out.routeFor(controllerKey, action),
    fileFound: true,
    gaps: out.gapsAgainst(displayPath),
  };
}
