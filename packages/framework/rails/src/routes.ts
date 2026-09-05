/**
 * Reads `config/routes.rb`, or whatever file a project points this
 * pack at, into a table of controller action -> HTTP method and path.
 *
 * The grammar read here is bounded on purpose: `resources`/`resource`
 * with `only:`/`except:`, `member`/`collection` blocks, one level of
 * resource nesting, `namespace`, `scope module:`/`scope path:`, the
 * bare HTTP-verb methods with `to:` or the `"path" => "controller#action"`
 * spelling, and `root`. Anything else the file declares, `mount`,
 * `draw`, `concern`, `constraints`, `match`, `direct` among them, is
 * left unread and reported once as a gap rather than guessed at. The
 * package README says why each of those stops here.
 */

import fs from "node:fs";

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
  /** The prefix a resource or route nested one level inside this one is written under, `/orders/:order_id`. */
  nestedBase: string;
  /** Which base a bare verb call with no `on:` inside this scope uses. Null directly inside a `resources` block, where Rails itself requires `on:` or a `member`/`collection` wrapper. */
  ambientBase: string | null;
}

interface RouteContext {
  pathPrefix: string;
  modulePrefix: string;
  resource?: ResourceScope;
}

interface SimpleArgs {
  positional: RbNode[];
  keyword: Record<string, RbNode>;
  /** The one `"key" => value` pair a call argument list can carry, tree-sitter's shape for a bare hash literal argument written with the hash-rocket operator instead of a `key:` shorthand. */
  hashRocketPair: { key: RbNode; value: RbNode } | null;
}

function readSimpleArgs(call: RbNode): SimpleArgs {
  const argumentList = field(call, "arguments");
  const positional: RbNode[] = [];
  const keyword: Record<string, RbNode> = {};
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
    const symbolKey = hashKeySymbolName(keyNode);
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
  if (/(s|x|z|ch|sh)$/.test(word)) {
    return `${word}es`;
  }
  return `${word}s`;
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

  add(controllerKey: string, action: string, route: Route): void {
    this.byKey.set(`${controllerKey}#${action}`, route);
  }

  recordUnread(callName: string): void {
    this.unread.add(callName);
  }

  routeFor(controllerKey: string, action: string): Route | null {
    return this.byKey.get(`${controllerKey}#${action}`) ?? null;
  }

  gapsAgainst(displayPath: string): string[] {
    if (this.unread.size === 0) {
      return [];
    }
    const names = [...this.unread].sort().join(", ");
    return [
      `${displayPath} also declares ${names}, which this pack does not read; whatever those declarations route is missing from what suss reports`,
    ];
  }
}

function joinKey(prefix: string, segment: string): string {
  return prefix === "" ? segment : `${prefix}/${segment}`;
}

function joinPath(prefix: string, segment: string): string {
  return `${prefix}/${segment}`;
}

function handleResourceCall(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
  plural: boolean,
): void {
  const args = readSimpleArgs(call);
  const symbol = args.positional[0] ? symbolValue(args.positional[0]) : null;
  if (symbol === null) {
    return;
  }
  const controllerSegment = plural ? symbol : pluralize(symbol);
  const controllerKey = joinKey(ctx.modulePrefix, controllerSegment);
  const prefixBase =
    ctx.resource !== undefined ? ctx.resource.nestedBase : ctx.pathPrefix;
  const base = joinPath(prefixBase, symbol);

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

  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return;
  }
  const nested: ResourceScope = {
    controllerKey,
    collectionBase: base,
    memberBase: plural ? `${base}/:id` : base,
    nestedBase: `${base}/:${singularize(symbol)}_id`,
    ambientBase: null,
  };
  walkBody(body, { ...ctx, resource: nested }, out);
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

function handleVerb(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
  method: string,
): void {
  const args = readSimpleArgs(call);
  const target = readRouteTarget(args);
  if (target !== null) {
    const literalPath = args.positional[0]
      ? stringValueOf(args.positional[0])
      : null;
    const path = target.path ?? literalPath;
    if (path !== null) {
      out.add(target.controllerKey, target.action, {
        method,
        path: `${ctx.pathPrefix}${path}`,
      });
    }
    return;
  }

  if (ctx.resource === undefined) {
    return;
  }
  const symbol = args.positional[0] ? symbolValue(args.positional[0]) : null;
  if (symbol === null) {
    return;
  }
  const on = wordValue(args.keyword.on);
  const base =
    on === "collection"
      ? ctx.resource.collectionBase
      : on === "member"
        ? ctx.resource.memberBase
        : ctx.resource.ambientBase;
  if (base === null) {
    return;
  }
  out.add(ctx.resource.controllerKey, symbol, {
    method,
    path: `${base}/${symbol}`,
  });
}

function handleRoot(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call);
  const target =
    readRouteTarget(args) ??
    (args.positional[0]
      ? splitControllerAction(stringValueOf(args.positional[0]) ?? "")
      : null);
  if (target !== null) {
    out.add(target.controllerKey, target.action, {
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
  const args = readSimpleArgs(call);
  const symbol = args.positional[0] ? symbolValue(args.positional[0]) : null;
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (symbol === null || body === null) {
    return;
  }
  walkBody(
    body,
    {
      pathPrefix: joinPath(ctx.pathPrefix, symbol),
      modulePrefix: joinKey(ctx.modulePrefix, symbol),
    },
    out,
  );
}

function handleScope(
  call: RbNode,
  ctx: RouteContext,
  out: RouteAccumulator,
): void {
  const args = readSimpleArgs(call);
  const moduleName = wordValue(args.keyword.module);
  const pathSegment = wordValue(args.keyword.path);
  const block = field(call, "block");
  const body = block !== null ? field(block, "body") : null;
  if (body === null) {
    return;
  }
  walkBody(
    body,
    {
      pathPrefix:
        pathSegment !== null
          ? joinPath(ctx.pathPrefix, pathSegment)
          : ctx.pathPrefix,
      modulePrefix:
        moduleName !== null
          ? joinKey(ctx.modulePrefix, moduleName)
          : ctx.modulePrefix,
    },
    out,
  );
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
  const out = new RouteAccumulator();
  const body = drawBlockBody(tree.rootNode);
  if (body !== null) {
    walkBody(body, { pathPrefix: "", modulePrefix: "" }, out);
  }
  return {
    routeFor: (controllerKey, action) => out.routeFor(controllerKey, action),
    fileFound: true,
    gaps: out.gapsAgainst(displayPath),
  };
}
