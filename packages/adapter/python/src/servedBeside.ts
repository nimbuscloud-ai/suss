/**
 * What a Python framework serves beside its routes, written on every
 * route its pack recognized. The checker reports a call to a missing
 * route only in a service whose routes all carry one.
 *
 * The pack states where to read each part: the pages and the static
 * folder an app serves of its own accord, and the calls on an app or a
 * router that mount another app, add a route the route table does not
 * read, add middleware, or add an error handler. Two parts come from the
 * run instead: each mount the route table could not follow, and each
 * middleware or error handler a decorator registers on the app that
 * responds to a request itself. DESIGN.md has the details.
 */

import path from "node:path";

import { restBinding, wrapperFor, wrapperIndex } from "@suss/behavioral-ir";
import { stampServedBeside } from "@suss/extractor";
import { boundaryKey } from "@suss/ir-core";
import { constructedFrom, imported, pickedFrom } from "@suss/recognize";

import { rangeOf } from "./ast.js";
import { pythonModuleOps } from "./declaredDiscovery.js";
import { routePathIn } from "./discovery.js";
import { nodeOfResolutionKey } from "./values/evaluator.js";

import type {
  BehavioralSummary,
  Output,
  ServedBesideEntry,
  ValueRef,
} from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { CallOps, EntryPick, ModuleOps, ValueOps } from "@suss/extractor";
import type { BoundPythonFile } from "./boundFiles.js";
import type {
  PyBuiltInPath,
  PyErrorHandlerCall,
  PyMiddlewareCall,
  PyMountCall,
  PyRouteCall,
  PyServedBeside,
  PyServer,
  PyServingCall,
  PythonDiscoveryPattern,
  PythonPack,
} from "./pack.js";
import type { DeclaredRouteIndex } from "./routeTables.js";
import type { PythonWrapperIndex } from "./wrappers.js";

export interface ServedBesideRun {
  packs: readonly PythonPack[];
  files: readonly BoundPythonFile[];
  facts: Database;
  routes: DeclaredRouteIndex;
  wrappers: PythonWrapperIndex;
}

/** Writes, on each route of every pack that states it, what the pack and the run read beside its routes. */
export function stampPythonServedBeside(
  summaries: readonly BehavioralSummary[],
  run: ServedBesideRun,
): void {
  const recognized = new Set(
    summaries.map((summary) => summary.identity.boundaryBinding?.recognition),
  );
  const modules = run.files.map((file) => pythonModuleOps(file, run.facts));
  for (const pack of run.packs) {
    const declared = pack.servedBeside;
    if (declared === undefined || !recognized.has(pack.name)) {
      continue;
    }
    const calls = callsMentioning(modules, wordsOf(pack, declared));
    const pending: Omit<Reading, "registered"> = {
      pack,
      facts: run.facts,
      carriers: carriersOf(pack, calls),
      prefixes: routePrefixes(pack, run.routes),
    };
    const sites = calls.flatMap(({ call, module }) =>
      declared.servers.flatMap((server) => {
        const at = { call, module, server, reading: pending };
        return call.isFrom(server.made) || servingCallOf(at) !== undefined
          ? [at]
          : [];
      }),
    );
    const reading: Reading = { ...pending, registered: registrationsIn(sites) };
    stampServedBeside(summaries, pack.name, [
      ...sites.flatMap((site) => siteEntries({ ...site, reading })),
      ...unfollowedEntries(pack, run),
      ...routesNothingServes(pack, summaries, run),
      ...respondingWrappers(pack, summaries, run),
    ]);
  }
}

/** What one pack's reading needs besides the call in hand. */
interface Reading {
  pack: PythonPack;
  facts: Database;
  /** The construction sites the pack's route table reads as the carrier of a root. */
  carriers: ReadonlySet<string>;
  /** Every prefix of every route the pack's tables declare, `/` included. */
  prefixes: readonly string[];
  /** By construction site, each path the app registers a server under, null where one did not read. */
  registered: ReadonlyMap<string, readonly (string | null)[]>;
}

/** One call, with the file it is read in, as each part of a server reads it. */
interface CallSite {
  call: CallOps;
  module: ModuleOps;
  reading: Reading;
  server: PyServer;
}

interface FileCall {
  call: CallOps;
  module: ModuleOps;
}

/** Every call written in a file that mentions one of the words. */
function callsMentioning(
  modules: readonly ModuleOps[],
  words: readonly string[],
): FileCall[] {
  return modules.flatMap((module) =>
    words.some((word) => module.mentions(word))
      ? module.calls("file").map((call) => ({ call, module }))
      : [],
  );
}

/** The words a file has to mention to write a call the reading reads: a server's construction or a call on it, or a root of the pack's table. */
function wordsOf(pack: PythonPack, declared: PyServedBeside): string[] {
  return [
    ...declared.servers.flatMap((server) => [
      ...(server.made.named ?? []),
      ...Object.keys(server.calls),
    ]),
    ...pack.discovery.flatMap((pattern) => {
      const roots = pattern.routes.table.roots;
      return [
        ...Object.keys(roots.kinds),
        ...(roots.carrier?.handedBy === undefined
          ? []
          : [roots.carrier.handedBy]),
      ];
    }),
  ];
}

/** What a call on the server registers, or undefined for a call the server's declaration does not list. */
function servingCallOf(
  at: Omit<CallSite, "reading">,
): PyServingCall | undefined {
  const method = at.call.method();
  if (method === null || !Object.hasOwn(at.server.calls, method)) {
    return undefined;
  }
  return at.call.receiverIsFrom(at.server.made)
    ? at.server.calls[method]
    : undefined;
}

function siteEntries(at: CallSite): ServedBesideEntry[] {
  if (at.call.isFrom(at.server.made)) {
    return constructionEntries(at);
  }
  const serving = servingCallOf(at);
  return serving === undefined
    ? []
    : CALL_ENTRIES[serving.serves](serving as never, at);
}

/**
 * Each path the app registers a server under, such as the blueprint a
 * Flask app's `register_blueprint` puts under its `url_prefix`, by the
 * site of the server's construction.
 */
function registrationsIn(
  sites: readonly Omit<CallSite, "reading">[],
): Map<string, (string | null)[]> {
  const registered = new Map<string, (string | null)[]>();
  for (const at of sites) {
    const serving = servingCallOf(at);
    if (
      serving?.serves !== "mount" ||
      serving.ownPath === undefined ||
      at.server.paths !== "asWritten"
    ) {
      continue;
    }
    const built = mountedValue(serving, at.call);
    const site = built?.site?.();
    if (site !== undefined) {
      registered.set(site, [
        ...(registered.get(site) ?? []),
        mountPath(serving, at.call, built),
      ]);
    }
  }
  return registered;
}

/** What a server's construction states: the paths it serves of its own accord, its static folder, and what it is handed that the pack does not read. */
function constructionEntries(at: CallSite): ServedBesideEntry[] {
  const { call, server } = at;
  return [
    ...(server.builtIn ?? []).flatMap((builtIn) => builtInEntries(builtIn, at)),
    ...staticFolderEntries(at),
    ...(server.unreadKeywords ?? []).flatMap((keyword) =>
      (call.keywordAt?.(keyword) ?? null) === null
        ? []
        : [entryAt(at, { by: "unread" })],
    ),
  ];
}

function builtInEntries(
  builtIn: PyBuiltInPath,
  at: CallSite,
): ServedBesideEntry[] {
  const written =
    builtIn.keyword === undefined
      ? builtIn.path
      : keywordText(at.call, builtIn.keyword, builtIn.path);
  // Both libraries test the keyword for truth, so an empty path turns it off.
  if (written === false || written === "") {
    return [];
  }
  const methods = [...builtIn.methods];
  if (written === null) {
    return [entryAt(at, { by: "page", methods })];
  }
  const served =
    builtIn.under === "routes"
      ? at.reading.prefixes.map((prefix) => ({
          path: routePathOf(at.reading.pack, joined(prefix, written)),
        }))
      : servedAt(at, [written]);
  return served.map((one) => entryAt(at, { by: "page", methods, ...one }));
}

/**
 * The paths a call on the server serves, under each prefix it is served
 * at. With a prefix that did not read, one entry with no path, any path.
 */
function servedAt(at: CallSite, paths: readonly string[]): { path?: string }[] {
  const prefixes = prefixesOf(at);
  if (prefixes === null) {
    return [{}];
  }
  return prefixes.flatMap((prefix) =>
    paths.map((one) => ({
      path: routePathOf(at.reading.pack, joined(prefix, one)),
    })),
  );
}

/** The prefixes the server's paths are served under: none on the app, and each path the app registers it at otherwise. Null when one did not read. */
function prefixesOf(at: CallSite): readonly string[] | null {
  if (at.server.paths === "asWritten") {
    return [""];
  }
  if (at.server.servedWhereRegistered !== true) {
    return null;
  }
  const server = at.call.isFrom(at.server.made) ? at.call : at.call.receiver();
  const site = server?.site?.();
  const registered =
    site === undefined ? undefined : at.reading.registered.get(site);
  if (registered === undefined || registered.length === 0) {
    return null;
  }
  return registered.every((one) => one !== null)
    ? (registered as readonly string[])
    : null;
}

/**
 * The static folder the construction states, served at the path it
 * states or at `/` and the folder's last name. A folder of `None` serves
 * nothing, and one this reading cannot tell may serve any path.
 */
function staticFolderEntries(at: CallSite): ServedBesideEntry[] {
  const folder = at.server.staticFolder;
  if (folder === undefined) {
    return [];
  }
  const methods = [...folder.methods];
  const anyPath = [entryAt(at, { by: "static", methods })];
  const positional = at.call.positionalCount?.() ?? at.call.argumentCount();
  if (positional > folder.positionalBefore) {
    return anyPath;
  }
  const named = keywordText(
    at.call,
    folder.folder.keyword,
    folder.folder.default,
  );
  if (named === false) {
    return [];
  }
  if (named === null) {
    return anyPath;
  }
  // `None` for the path means the default, as leaving it out does.
  const urlPath = keywordText(at.call, folder.urlPath, null);
  if (urlPath === null) {
    return anyPath;
  }
  const servedFrom = urlPath === false ? `/${path.basename(named)}` : urlPath;
  return servedAt(at, [everythingUnder(servedFrom)]).map((one) =>
    entryAt(at, { by: "static", methods, ...one }),
  );
}

/**
 * The text the call passes under a keyword: `unstated` when it passes
 * none, false when it passes `None` or `False` or nothing is unstated,
 * and null when what it passes does not read.
 */
function keywordText(
  call: CallOps,
  keyword: string,
  unstated: string | null,
): string | false | null {
  const stated = call.keywordAt?.(keyword) ?? null;
  if (stated === null) {
    return unstated ?? false;
  }
  return textOf(stated);
}

const CALL_ENTRIES: {
  readonly [S in PyServingCall["serves"]]: (
    serving: Extract<PyServingCall, { serves: S }>,
    at: CallSite,
  ) => ServedBesideEntry[];
} = {
  route: routeEntries,
  mount: mountEntries,
  middleware: middlewareEntries,
  errorHandler: errorHandlerEntries,
};

/** A route the table does not read, at its path for the methods it serves. */
function routeEntries(serving: PyRouteCall, at: CallSite): ServedBesideEntry[] {
  const methods = methodsOf(serving, at.call);
  const by = {
    by: "unread" as const,
    ...(methods === null ? {} : { methods }),
  };
  const written = pathPicked(at.call, serving.path);
  if (written === null || written === undefined) {
    return [entryAt(at, by)];
  }
  return servedAt(at, [written]).map((one) => entryAt(at, { ...by, ...one }));
}

/** The methods a route call serves, or null for every method. */
function methodsOf(serving: PyRouteCall, call: CallOps): string[] | null {
  if (Array.isArray(serving.methods)) {
    return [...serving.methods];
  }
  const { pick, unstated } = serving.methods as Exclude<
    PyRouteCall["methods"],
    readonly string[]
  >;
  return methodsListed(pickedFrom(call, [pick]), unstated);
}

/** The methods a list gives, upper-cased, the unstated ones when the call passes none, or null for every method. */
function methodsListed(
  listed: ValueOps | undefined,
  unstated: readonly string[] | undefined,
): string[] | null {
  if (listed === undefined || listed.nothing?.() === true) {
    return unstated === undefined ? null : [...unstated];
  }
  const texts = listed.items().map((item) => item.text());
  return texts.length === 0 || texts.some((text) => text === null)
    ? null
    : texts.map((text) => (text ?? "").toUpperCase());
}

/**
 * Another app, a blueprint or a static file server, mounted at a path.
 * Everything under the path is served by it, so a value the pack's table
 * reads as a carrier, whose routes the table puts under the same path,
 * is left out.
 */
function mountEntries(serving: PyMountCall, at: CallSite): ServedBesideEntry[] {
  const built = mountedValue(serving, at.call);
  const site = built?.site?.();
  if (
    serving.exceptCarriers === true &&
    site !== undefined &&
    at.reading.carriers.has(site)
  ) {
    return [];
  }
  const servesStatic = (serving.staticServers ?? []).some(
    (server) =>
      built?.isFrom(
        imported({ from: [server.module], named: server.names }),
      ) === true,
  );
  const by = servesStatic
    ? { by: "static" as const, methods: ["GET", "HEAD"] }
    : { by: "mount" as const };
  const mountedAt = mountPath(serving, at.call, built);
  if (mountedAt === null) {
    return [entryAt(at, by)];
  }
  return servedAt(at, [everythingUnder(mountedAt)]).map((one) =>
    entryAt(at, { ...by, ...one }),
  );
}

/** The call that built the value a mount mounts, or null when it comes to none. */
function mountedValue(serving: PyMountCall, call: CallOps): CallOps | null {
  return builtBy(pickedFrom(call, serving.app));
}

/** The call a value was built by, through names and fields, or null when it comes to none. */
function builtBy(value: ValueOps | undefined): CallOps | null {
  return value?.asCall?.({ follow: "namesAndFields" }) ?? null;
}

/** The path a mount puts its value under: the one it states, else the one the value's construction states, else the root. Null when it does not read. */
function mountPath(
  serving: PyMountCall,
  call: CallOps,
  built: CallOps | null,
): string | null {
  const stated = pathPicked(call, serving.at);
  if (stated !== undefined) {
    return stated;
  }
  if (serving.ownPath === undefined || built === null) {
    return null;
  }
  return pathPicked(built, serving.ownPath) ?? "";
}

/** Middleware the library ships responds to the methods it lists, and any other may respond to any request. */
function middlewareEntries(
  serving: PyMiddlewareCall,
  at: CallSite,
): ServedBesideEntry[] {
  const added = pickedFrom(at.call, serving.middleware);
  const known =
    added === undefined
      ? undefined
      : serving.known.find((one) =>
          importedAs(added, at.module, one.module, one.names),
        );
  if (known === undefined) {
    return [entryAt(at, { by: "middleware" })];
  }
  return known.respondsTo.length === 0
    ? []
    : [entryAt(at, { by: "middleware", methods: [...known.respondsTo] })];
}

/** An error handler may serve any path when it handles the error the library raises for a path no route serves. */
function errorHandlerEntries(
  serving: PyErrorHandlerCall,
  at: CallSite,
): ServedBesideEntry[] {
  const handled = pickedFrom(at.call, serving.handles);
  return handled !== undefined && !mayBeNotFound(handled, serving)
    ? []
    : [entryAt(at, { by: "unread" })];
}

/**
 * Whether a handler registered for this status or exception class may
 * catch the not-found error. A class the project writes, or one the
 * language has other than the root of every exception, cannot.
 */
function mayBeNotFound(
  handled: ValueOps,
  serving: PyErrorHandlerCall,
): boolean {
  const { notFound } = serving;
  const written = handled.evaluated?.() ?? handled.literal?.() ?? null;
  if (typeof written === "number") {
    return written === notFound.status;
  }
  const from = handled.importedFrom?.() ?? null;
  if (from !== null) {
    return notFound.modules.includes(from);
  }
  const name = handled.source?.() ?? "";
  return !/^[A-Za-z_]\w*$/.test(name) || notFound.ancestors.includes(name);
}

/** Whether the value is a name the file imports from the module under one of the names. */
function importedAs(
  value: ValueOps,
  module: ModuleOps,
  from: string,
  names: readonly string[],
): boolean {
  if (value.importedFrom?.() !== from) {
    return false;
  }
  const exported = module.importedNames([from]).get(value.source?.() ?? "");
  return exported !== undefined && names.includes(exported);
}

/**
 * Each mount the pack's route table could not follow, such as one of a
 * router a library builds, serves every path under where it is mounted,
 * or any path when that did not read.
 */
function unfollowedEntries(
  pack: PythonPack,
  run: ServedBesideRun,
): ServedBesideEntry[] {
  const files = new Map(run.files.map((file) => [file.displayPath, file.file]));
  return pack.discovery.flatMap((pattern) =>
    run.routes.unfollowed(pattern).map((gap) => {
      const where = {
        file: files.get(gap.file) ?? gap.file,
        line: 1,
        written: gap.name,
      };
      return gap.kind === "unread" && gap.at !== undefined
        ? {
            by: "mount" as const,
            path: routePathOf(pack, everythingUnder(gap.at)),
            ...where,
          }
        : { by: "unread" as const, ...where };
    }),
  );
}

/**
 * Each app-wide middleware or error handler that responds itself with anything but an error
 * status, or may replace what its continuation returned. It runs whether or not a route matches.
 */
function respondingWrappers(
  pack: PythonPack,
  summaries: readonly BehavioralSummary[],
  run: ServedBesideRun,
): ServedBesideEntry[] {
  const index = wrapperIndex(summaries);
  const files = new Map(run.files.map((file) => [file.displayPath, file.file]));
  return run.wrappers.decoratedOnApp(pack.name).flatMap((registered) => {
    const { reference } = registered;
    const wrapper = wrapperFor(index, reference);
    if (
      wrapper !== undefined &&
      !registered.mayReplaceResponse &&
      !respondsItself(wrapper)
    ) {
      return [];
    }
    return [
      {
        by: "middleware" as const,
        file: files.get(reference.file) ?? reference.file,
        line: wrapper?.location.range.start ?? 1,
        written: reference.name,
      },
    ];
  });
}

/** Whether one of the wrapper's outcomes, other than handing the request on, is a response other than an error status. */
function respondsItself(wrapper: BehavioralSummary): boolean {
  return wrapper.transitions.some(({ output }) =>
    OWN_RESPONSE[output.type](output as never),
  );
}

/** Whether an outcome of this type serves the request. A hook that ends with no value hands the request on. */
const OWN_RESPONSE: {
  readonly [T in Output["type"]]: (
    output: Extract<Output, { type: T }>,
  ) => boolean;
} = {
  response: (output) => !errorStatus(output.statusCode),
  render: () => true,
  return: () => true,
  emit: () => true,
  throw: () => false,
  delegate: () => false,
  void: () => false,
  exit: () => false,
};

function errorStatus(status: ValueRef | null): boolean {
  return (
    status?.type === "literal" &&
    typeof status.value === "number" &&
    status.value >= 400
  );
}

/**
 * The construction sites each of the pack's tables reads as the carrier
 * of a root, as the blueprint a flask-restx `Api` is built on or handed
 * by `init_app`. The table puts the root's routes under its path.
 */
function carriersOf(pack: PythonPack, calls: readonly FileCall[]): Set<string> {
  const sites = new Set<string>();
  for (const pattern of pack.discovery) {
    const table = pattern.routes.table;
    const carrier = table.roots.carrier;
    if (carrier === undefined) {
      continue;
    }
    const root = constructedFrom({
      from: table.from ?? [],
      named: Object.keys(table.roots.kinds),
    });
    for (const { call } of calls) {
      const handing =
        call.isFrom(root) ||
        (carrier.handedBy !== undefined &&
          call.method() === carrier.handedBy &&
          call.receiverIsFrom(root));
      const site = handing
        ? builtBy(pickedFrom(call, [carrier.at]))?.site?.()
        : undefined;
      if (site !== undefined) {
        sites.add(site);
      }
    }
  }
  return sites;
}

/** Every prefix of every path the pack's route tables serve a route at, the root included. */
function routePrefixes(pack: PythonPack, routes: DeclaredRouteIndex): string[] {
  const prefixes = new Set<string>();
  for (const pattern of pack.discovery) {
    for (const route of routes.declared(pattern)) {
      const segments = routePathIn(pattern, route.path ?? "")
        .split("/")
        .filter((one) => one !== "");
      for (let count = 0; count < segments.length; count += 1) {
        prefixes.add(`/${segments.slice(0, count).join("/")}`);
      }
    }
  }
  return [...prefixes].sort();
}

/**
 * Each route the pack's table declares that no summary serves, such as
 * a flask-restx resource whose own path the discovery could not read.
 * It may serve its path, or any path when the table could not read it.
 */
function routesNothingServes(
  pack: PythonPack,
  summaries: readonly BehavioralSummary[],
  run: ServedBesideRun,
): ServedBesideEntry[] {
  const served = new Set<string>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    const key =
      binding?.recognition === pack.name ? boundaryKey(binding) : null;
    if (key !== null) {
      served.add(key);
    }
  }
  const entries = new Map<string, ServedBesideEntry>();
  for (const pattern of pack.discovery) {
    for (const route of run.routes.declared(pattern)) {
      const path =
        route.path === null ? null : routePathIn(pattern, route.path);
      const key =
        path === null || route.method === null
          ? null
          : boundaryKey(
              restBinding({
                transport: pack.protocol,
                method: route.method,
                path,
                recognition: pack.name,
              }),
            );
      if (key !== null && served.has(key)) {
        continue;
      }
      const node = nodeOfResolutionKey(route.call.site?.() ?? "", run.facts);
      const entry: ServedBesideEntry = {
        by: "unread",
        ...(path === null ? {} : { path }),
        ...(route.method === null ? {} : { methods: [route.method] }),
        file: route.call.file?.() ?? "",
        line: node === null ? 1 : rangeOf(node).start,
        written: route.call.calleeText(),
      };
      entries.set(JSON.stringify(entry), entry);
    }
  }
  return [...entries.values()];
}

/** The path a pick states: undefined when the call passes nothing there, null when it passes something that does not read. */
function pathPicked(
  call: CallOps,
  picks: readonly EntryPick[],
): string | null | undefined {
  return pathWritten(pickedFrom(call, picks));
}

function pathWritten(value: ValueOps | undefined): string | null | undefined {
  if (value === undefined || value.nothing?.() === true) {
    return undefined;
  }
  return value.text();
}

/** The text a keyword states, false for `None` or `False`, and null for anything else. */
function textOf(value: ValueOps): string | false | null {
  if (value.nothing?.() === true || value.literal?.() === false) {
    return false;
  }
  return value.text();
}

function everythingUnder(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  const rooted =
    trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${rooted}/{path*}`;
}

function joined(prefix: string, rest: string): string {
  const head = prefix.replace(/\/+$/, "");
  const tail = rest.startsWith("/") ? rest : `/${rest}`;
  return tail === "/" && head !== "" ? head : `${head}${tail}`;
}

/** A path the library writes, read in the syntax of the pack's route paths. */
function routePathOf(pack: PythonPack, written: string): string {
  const pattern: PythonDiscoveryPattern | undefined = pack.discovery[0];
  return pattern === undefined ? written : routePathIn(pattern, written);
}

function entryAt(
  at: CallSite,
  entry: Pick<ServedBesideEntry, "by" | "path" | "methods">,
): ServedBesideEntry {
  const node = nodeOfResolutionKey(at.call.site?.() ?? "", at.reading.facts);
  return {
    ...entry,
    file: at.call.file?.() ?? at.module.path(),
    line: node === null ? 1 : rangeOf(node).start,
    written: at.call.calleeText(),
  };
}
