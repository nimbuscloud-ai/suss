// registrationCall.ts (discovery handler): handlers registered
// through a library call. Covers Express (`app.get("/users", h)`),
// ts-rest (`s.router(contract, { getUser })`), Fastify, and similar
// shapes where a runtime API call associates a handler function with a
// route or operation.
//
// `router.get("/users", listUsers)` is how most Express code is
// written, and reading the syntax at the argument position sees an
// identifier and gets no further. Which function that is, and which
// object has the route's method and path on it, both go to the fact
// layer.

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import { joinMountedPath } from "@suss/resolution";

import { nodeId } from "../facts/extract.js";
import { pathFromArgument } from "../resolve/routePath.js";
import { resolveImportedLocalName } from "./resolveImport.js";
import {
  functionValueOf,
  objectLiteralOf,
  writtenNodeOf,
} from "./resolveValue.js";
import { namesAParameter } from "./shared.js";

import type {
  BindingExtraction,
  DiscoveryPattern,
  PatternPack,
} from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

/**
 * What a route's path should be composed with once mount discovery has
 * run: the prefix a router was mounted under, following however many
 * routers it was mounted onto in turn. Built once per extraction by
 * `buildMountPrefixIndex`, over every mount call the active packs'
 * `DiscoveryPattern.mount` config recognizes.
 */
export interface MountPrefixIndex {
  /**
   * The prefix routes on `routerNode` (a registration subject's own
   * creation site, e.g. a `Router()` call) were mounted under. Empty
   * when nothing mounts it, or when a mount call along the way
   * couldn't be resolved to a literal prefix and a concrete router.
   */
  effectivePrefixFor(routerNode: Node): string;
  /**
   * The same resolution by a router's node id, for callers replaying a
   * recorded consumption without the node in hand (the per-file cache
   * re-checks a stored prefix against a rebuilt index this way).
   */
  prefixForId?(childId: string): string;
}

/** One mount call this file states, before it's folded into the index. */
export interface MountEdgeCandidate {
  /** Identity of the registration subject the mount call was made on. */
  parentRouterId: string;
  /** Identity of the router the mount registers `prefix` for. */
  childRouterId: string;
  prefix: string;
}

export function discoverRegistrationCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  kind: string,
  bindingExtraction?: BindingExtraction,
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  // Steps 1 and 2: which import this pattern is about, and which
  // variables in the file are set to the result of calling it.
  const registrationSubjects = registrationSubjectsOf(
    sourceFile,
    match.importModule,
    match.importName,
    resolution,
  );
  if (
    registrationSubjects.size === 0 &&
    !storeCanFindSubjects(sourceFile, match, resolution)
  ) {
    return results;
  }

  // Step 3: Walk all call expressions and match registration chains
  const registrationMethods = match.registrationChain.map((c) =>
    c.startsWith(".") ? c.slice(1) : c,
  );

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return;
    }

    const methodName = callee.getName();
    if (!registrationMethods.includes(methodName)) {
      return;
    }

    // The subject of the call must resolve to our registration variable
    const subjectNode = subjectNodeFor(
      callee.getExpression(),
      registrationSubjects,
      match,
      resolution,
    );

    if (subjectNode === undefined) {
      return;
    }

    // Step 4: Extract handlers from the call
    const args = node.getArguments();
    const registrationSubjectId = nodeId(subjectNode);

    // ts-rest style: second arg is object literal with handler methods
    let foundObjectArg = false;
    for (const arg of args) {
      if (!Node.isObjectLiteralExpression(arg)) {
        continue;
      }

      foundObjectArg = true;
      for (const prop of arg.getProperties()) {
        // Method shorthand: { async getUser() { ... } }
        if (Node.isMethodDeclaration(prop)) {
          results.push({
            func: prop,
            kind,
            name: prop.getName(),
            registrationSubjectId,
          });
          continue;
        }

        if (!Node.isPropertyAssignment(prop)) {
          continue;
        }

        const propInit = prop.getInitializer();
        if (propInit === undefined) {
          continue;
        }

        const held = functionValueOf(propInit, resolution);
        if (held !== null) {
          results.push({
            func: held,
            kind,
            name: prop.getName(),
            registrationSubjectId,
          });
        }
      }
    }

    if (!foundObjectArg) {
      // Last-arg-function style: works for any pack whose registration
      // shape is `subject.<method>(arg0, ..., handler)`. The pack's
      // own `bindingExtraction` decides whether the surrounding call
      // has a (method, path) pair the adapter can lift into a routed
      // boundary binding: HTTP packs declare this (their `method`
      // and `path` extractors point at the registration call); a
      // non-HTTP pack like a future `bus.on("event", handler)` would
      // simply omit those extractors, and the adapter falls back to
      // function-call binding.
      const lastArg = args[args.length - 1] as Node | undefined;
      const handler =
        lastArg === undefined ? null : functionValueOf(lastArg, resolution);
      const routeInfo = withMountPrefix(
        bindingExtraction !== undefined
          ? extractRouteInfoFromBinding(
              node,
              methodName,
              bindingExtraction,
              resolution,
            )
          : null,
        subjectNode,
        mountPrefixes,
      );
      if (handler !== null) {
        results.push({
          func: handler,
          kind,
          // The verb is there to label the unit for the reader; nothing calls it.
          name: methodName,
          nameKind: "label",
          registrationSubjectId,
          ...(routeInfo !== null ? { routeInfo } : {}),
        });
        return;
      }
      // A route this call gives, registered with a handler its own
      // caller supplies. The route is a fact about the code, and the
      // handler is something we could not read, so report the boundary
      // and record what was missed. Every other unresolved argument is a
      // chain that could still be followed, and reporting those the same
      // way would present a missing rule as a fact about the code.
      if (
        routeInfo !== null &&
        lastArg !== undefined &&
        namesAParameter(lastArg)
      ) {
        results.push({
          func: null,
          announcedAt: node,
          kind,
          name: methodName,
          nameKind: "label",
          registrationSubjectId,
          routeInfo,
        });
      }
    }
  });

  return results;
}

/**
 * `routeInfo` composed with whatever prefix `subjectNode`'s router was
 * mounted under, or `routeInfo` unchanged when there is nothing to
 * compose: no index was built for this run, the router was never
 * mounted, or a mount call along the way couldn't be resolved.
 */
function withMountPrefix(
  routeInfo: { method: string; path: string } | null,
  subjectNode: Node,
  mountPrefixes: MountPrefixIndex | undefined,
): { method: string; path: string } | null {
  if (routeInfo === null || mountPrefixes === undefined) {
    return routeInfo;
  }
  const prefix = mountPrefixes.effectivePrefixFor(subjectNode);
  return prefix === ""
    ? routeInfo
    : { ...routeInfo, path: joinMountedPath(prefix, routeInfo.path) };
}

/**
 * Read the facts of every file a pack that registers handlers applies
 * to, before anything asks which routable a registration was made on.
 *
 * What joins a route registered on a parameter to the app behind it is
 * the call that passed the app, and that call is in a file importing
 * this one. A store query widens the other way, along the imports of
 * the file it starts in, so the caller is somewhere it never arrives.
 * A run whose packs register nothing reads nothing here.
 */
export function readRegisteringFiles(
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>,
  resolution: ResolutionStore,
): void {
  const files: SourceFile[] = [];
  for (const [sourceFile, packs] of packsByFile) {
    const registers = packs.some((pack) =>
      pack.discovery.some(
        (pattern) => pattern.match.type === "registrationCall",
      ),
    );
    if (registers) {
      files.push(sourceFile);
    }
  }
  resolution.extractFiles(files);
}

/**
 * The routable a registration call's receiver is, or undefined when it
 * is not one. The map from `registrationSubjectsOf` settles the common
 * case in this file's own syntax. A receiver it misses is put to the
 * store, which follows however the value was moved: a class field, a
 * destructured name, a property on an object. The store keeps the
 * single-answer policy, so a receiver that could be two different
 * constructions is no subject.
 */
export function subjectNodeFor(
  subject: Node,
  subjects: ReadonlyMap<string, Node>,
  match: { importModule: string; importName: string },
  resolution: ResolutionStore | undefined,
): Node | undefined {
  if (Node.isIdentifier(subject)) {
    const known = subjects.get(subject.getText());
    if (known !== undefined) {
      return known;
    }
  }

  if (
    resolution === undefined ||
    !(Node.isIdentifier(subject) || Node.isPropertyAccessExpression(subject))
  ) {
    return undefined;
  }
  return (
    resolution.subjectConstructionOf(
      subject,
      match.importModule,
      match.importName,
    ) ?? undefined
  );
}

/**
 * Whether a file with no syntactic subject is still worth walking: it
 * imports the library, and there is a store to put receivers to. The
 * import gate is what keeps the store question from being asked about
 * every method call in every file.
 */
export function storeCanFindSubjects(
  sourceFile: SourceFile,
  match: { importModule: string; importName: string },
  resolution: ResolutionStore | undefined,
): boolean {
  return (
    resolution !== undefined &&
    resolveImportedLocalName(
      sourceFile,
      match.importModule,
      match.importName,
    ) !== null
  );
}

/**
 * The local variables in `sourceFile` set to the result of calling
 * `importName` (imported from `importModule`), plus any parameter
 * typed with it. This is what a registration call's subject, and a
 * mount call's subject, both have to resolve to: the routable itself.
 *
 * Shared between route, mount and wrapper discovery so the three ask
 * "which variable is the routable" the same way rather than growing
 * their own copies of import and call-shape resolution.
 *
 * A parameter comes back as the app a caller passed it when the store
 * settles on one, and as itself when there is no store or the store
 * settles on nothing.
 */
export function registrationSubjectsOf(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
  resolution?: ResolutionStore,
): Map<string, Node> {
  const importedLocalName = resolveImportedLocalName(
    sourceFile,
    importModule,
    importName,
  );

  const subjects = new Map<string, Node>();
  if (importedLocalName === null) {
    return subjects;
  }

  sourceFile.forEachDescendant((node) => {
    // A variable set to the result of calling the imported function, as
    // in `const router = Router()`. A factory builds its app inside its
    // own body, so the whole file is walked, not only its top level.
    if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      if (init === undefined) {
        return;
      }
      const calleeText =
        Node.isCallExpression(init) || Node.isNewExpression(init)
          ? init.getExpression().getText()
          : null;
      if (calleeText === importedLocalName) {
        subjects.set(node.getName(), init);
      }
      return;
    }

    // A parameter typed with the import is the app a caller passed, and
    // `creationSiteBehind` asks the store which app that was.
    if (!Node.isParameterDeclaration(node)) {
      return;
    }
    const typeNode = node.getTypeNode();
    if (typeNode === undefined) {
      return;
    }
    const typeText = typeNode.getText();
    if (
      typeText === importedLocalName ||
      typeText.startsWith(`${importedLocalName}<`)
    ) {
      subjects.set(node.getName(), creationSiteBehind(node, resolution));
    }
  });

  return subjects;
}

/**
 * The app a caller passed this parameter, so a route or a sub-router
 * registered on it keys on the same creation site as one registered in
 * the file that built the app.
 *
 * Two callers passing two different apps leave the parameter with two
 * values, and the store settles on neither. The parameter comes back
 * unchanged then, and a wrapper or a mount edge keyed on it reaches
 * only the registrations made on this parameter.
 */
function creationSiteBehind(
  parameter: Node,
  resolution: ResolutionStore | undefined,
): Node {
  if (resolution === undefined) {
    return parameter;
  }
  const written = resolution.resolveWrittenValue(parameter);
  if (
    written === null ||
    !(Node.isCallExpression(written) || Node.isNewExpression(written))
  ) {
    return parameter;
  }
  return written;
}

/**
 * The node ids of every registration subject in `sourceFile`, across
 * every distinct `(importModule, importName)` pair `matches` names.
 * What a mount call's target has to resolve to: the router being
 * mounted is usually tracked under a different import name than the
 * mount call's own subject (`Router()` versus `express()`), so
 * checking membership against one pattern's own subjects alone would
 * miss it. Callers pass every registrationCall pattern belonging to
 * one pack, never patterns from another, since a pack's own mount
 * shape only ever mounts a value that pack itself builds.
 */
export function registrationSubjectIdsOf(
  sourceFile: SourceFile,
  matches: ReadonlyArray<
    Extract<DiscoveryPattern["match"], { type: "registrationCall" }>
  >,
  resolution?: ResolutionStore,
): ReadonlySet<string> {
  const seenImports = new Set<string>();
  const ids = new Set<string>();
  for (const match of matches) {
    const importKey = `${match.importModule}::${match.importName}`;
    if (seenImports.has(importKey)) {
      continue;
    }
    seenImports.add(importKey);
    for (const node of registrationSubjectsOf(
      sourceFile,
      match.importModule,
      match.importName,
      resolution,
    ).values()) {
      ids.add(nodeId(node));
    }
  }
  return ids;
}

/**
 * Every mount call in `sourceFile` matching `mount`'s shape on a
 * variable this pattern's `match` already treats as the routable. The
 * prefix has to be a string literal and the target has to resolve to
 * a node in `knownSubjectIds`, the creation site of some registration
 * subject this run already tracks; either failing drops the call
 * rather than guessing, per the same convention
 * `extractRouteInfoFromBinding` follows for a route's own path.
 *
 * `knownSubjectIds` comes from the caller because a mount's target is
 * not necessarily one of THIS pattern's own subjects: `app.use(prefix,
 * router)` mounts a `Router()`-built value on an `express()`-built one,
 * two different import names the same pack's registrationCall patterns
 * track separately. What it must not include is another pack's
 * subjects: an Express `.use` mounting a Hono app is not a mount at
 * all, since Express never runs a Hono instance as middleware, so the
 * registry the caller passes is scoped to one pack, unioned across
 * every file that pack applies to.
 */
export function discoverMountEdges(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  mount: NonNullable<DiscoveryPattern["mount"]>,
  knownSubjectIds: ReadonlySet<string>,
  resolution?: ResolutionStore,
): MountEdgeCandidate[] {
  const subjects = registrationSubjectsOf(
    sourceFile,
    match.importModule,
    match.importName,
    resolution,
  );
  if (
    subjects.size === 0 &&
    !storeCanFindSubjects(sourceFile, match, resolution)
  ) {
    return [];
  }

  const edges: MountEdgeCandidate[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      callee.getName() !== mount.method
    ) {
      return;
    }

    const subjectNode = subjectNodeFor(
      callee.getExpression(),
      subjects,
      match,
      resolution,
    );
    if (subjectNode === undefined) {
      return;
    }

    const args = node.getArguments();
    const prefixArg = args[mount.prefixPosition] as Node | undefined;
    if (
      prefixArg === undefined ||
      !(
        Node.isStringLiteral(prefixArg) ||
        Node.isNoSubstitutionTemplateLiteral(prefixArg)
      )
    ) {
      return;
    }

    const targetNodes = mountTargetsAmong(
      args,
      mount.targetPosition,
      knownSubjectIds,
      resolution,
    );
    for (const targetNode of targetNodes) {
      edges.push({
        parentRouterId: nodeId(subjectNode),
        childRouterId: nodeId(targetNode),
        prefix: prefixArg.getLiteralValue(),
      });
    }
  });

  return edges;
}

/**
 * Every mounted router among a mount call's trailing arguments.
 * `app.use(prefix, router)` puts the router right after the prefix,
 * but middleware can come in between, and Express applies every
 * argument from `targetPosition` on at the same prefix: `app.use("/a",
 * r1, r2)` mounts both `r1` and `r2` under `/a`. So `targetPosition`
 * is a floor rather than a single fixed slot: nothing before it is a
 * candidate (that range is the prefix, and whatever else a pack's own
 * mount shape reserves there), and every argument from it onward that
 * resolves to a node `knownSubjectIds` already tracks as a
 * registration subject's own creation site becomes its own edge.
 *
 * Checking membership rather than accepting whatever resolves is what
 * keeps a middleware argument from being recorded as a mount target
 * in its own right: `writtenNodeOf` resolves a call expression to
 * itself whether or not it is a tracked router, and an edge keyed on
 * some other call's node id is never queried by anything, since
 * nothing else ever asks about that node's prefix.
 */
function mountTargetsAmong(
  args: readonly Node[],
  targetPosition: number,
  knownSubjectIds: ReadonlySet<string>,
  resolution: ResolutionStore | undefined,
): Node[] {
  const targets: Node[] = [];
  for (let position = targetPosition; position < args.length; position++) {
    const arg = args[position];
    if (arg === undefined) {
      continue;
    }
    const resolved = writtenNodeOf(arg, resolution);
    if (resolved !== null && knownSubjectIds.has(nodeId(resolved))) {
      targets.push(resolved);
    }
  }
  return targets;
}

/** The string a property of an object literal holds, or null. */
function stringProperty(obj: Node, name: string): string | null {
  if (!Node.isObjectLiteralExpression(obj)) {
    return null;
  }
  const property = obj.getProperty(name);
  if (property === undefined || !Node.isPropertyAssignment(property)) {
    return null;
  }
  const value = property.getInitializer();
  if (
    value !== undefined &&
    (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value))
  ) {
    return value.getLiteralValue();
  }
  return null;
}

/**
 * Read a (method, path) pair from a registration-style call site
 * using the pack's own `bindingExtraction` config. Only fires when
 * both halves of the config target the registration call itself
 * (the HTTP pattern: method comes from `.get` / `.post` / etc., path
 * is the first argument). Returns null when either half points
 * elsewhere (e.g. `fromContract`, `fromFilename`): those shapes
 * need other discovery wiring and don't apply at the registration
 * call site.
 *
 * The point of routing through `bindingExtraction` rather than
 * hardcoding HTTP assumptions is that registrationCall is a generic
 * shape: any pack whose registration looks like
 * `subject.method(arg0, ..., handler)` can use it. Only packs whose
 * `bindingExtraction` says "the method name IS the method and arg N
 * IS the path" should get routed-boundary bindings; everything else
 * stays on the function-call fallback.
 */
function extractRouteInfoFromBinding(
  call: CallExpression,
  methodName: string,
  binding: BindingExtraction,
  resolution?: ResolutionStore,
): { method: string; path: string } | null {
  // Both halves on one argument's properties: the registration passes
  // a route object, `app.openapi(route, handler)`, with the method and
  // path on it. The object usually lives on a
  // shared contract in another file, so the fact layer follows the
  // reference to the literal before the properties are read.
  if (
    binding.method.type === "fromArgumentProperty" &&
    binding.path.type === "fromArgumentProperty" &&
    binding.method.position === binding.path.position
  ) {
    const arg = call.getArguments()[binding.method.position];
    if (arg === undefined) {
      return null;
    }
    const routeObject = objectLiteralOf(arg, resolution);
    if (routeObject === null) {
      return null;
    }
    const method = stringProperty(routeObject, binding.method.property);
    const path = stringProperty(routeObject, binding.path.property);
    if (method === null || path === null) {
      return null;
    }
    return { method: method.toUpperCase(), path };
  }

  if (
    binding.method.type !== "fromRegistration" ||
    binding.path.type !== "fromArgument"
  ) {
    return null;
  }

  let method: string;
  if (binding.method.position === "methodName") {
    method = binding.method.nameMap?.[methodName] ?? methodName.toUpperCase();
  } else {
    const args = call.getArguments();
    const arg = args[binding.method.position] as Node | undefined;
    if (
      arg === undefined ||
      !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
    ) {
      return null;
    }
    method = arg.getLiteralValue().toUpperCase();
  }

  const pathArg = call.getArguments()[binding.path.position] as
    | Node
    | undefined;
  const path =
    pathArg === undefined ? undefined : pathFromArgument(pathArg, resolution);
  return path === undefined ? null : { method, path };
}
