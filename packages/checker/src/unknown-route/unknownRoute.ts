/**
 * A REST call to a path its own service does not serve.
 *
 * Pairing leaves such a call among the unpaired consumers, beside every
 * call to another company's API and every call suss could not read in
 * full. This pass reports one only when suss settled which service the
 * call goes to, read its method and its whole path, read that service's
 * whole route table along with what else serves requests there, and
 * found nothing that can take the call. A call whose service it could
 * not settle goes under `unchecked.routes` with the reason. The README
 * beside this file says why each condition is there.
 */

import {
  BOUNDARY_ROLE,
  deploymentOf,
  readHttpMetadata,
  readServedBesideMetadata,
  summaryIdentifier,
  summaryRef,
} from "@suss/behavioral-ir";
import {
  bucketsMeet,
  compareRanks,
  groundBinding,
  hostCanBeOwn,
  isCatchAll,
  methodsAgree,
  nameReference,
  normalizePath,
  originHost,
} from "@suss/ir-core";

import { isContractDocument } from "../contract/declaredContract.js";
import { servesCall } from "./servedBeside.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  ServedBesideEntry,
} from "@suss/behavioral-ir";
import type { Deployment } from "@suss/ir-core";

/** A call suss read in full whose service it could not settle, so nothing judged it. */
export interface UncheckedRoute {
  consumer: string;
  name: string;
  /** The call as `GET /orders/{id}`, with any base URL the deployment sets filled in. */
  call: string;
  reason: string;
}

interface RestCall {
  method: string;
  path: string;
  host?: string;
}

/** The routes one workspace serves, and what its packs say serves requests beside them. */
interface Service {
  name: string;
  routes: BehavioralSummary[];
  beside: Map<string, ServedBesideEntry[]>;
}

type Target =
  | { kind: "service"; service: Service }
  | { kind: "unsettled"; reason: string }
  | { kind: "elsewhere" };

const ELSEWHERE: Target = { kind: "elsewhere" };

/** How many routes nearby a finding lists. */
const NEARBY_LISTED = 5;

const OPENING_HOLE = /^\{[^{}]+\}(.*)$/;

/**
 * Report each unpaired REST consumer that calls a path its service does
 * not serve. `unchecked` collects the calls whose service suss could not
 * settle.
 */
export function checkUnknownRoutes(
  production: readonly BehavioralSummary[],
  unpairedConsumers: readonly BehavioralSummary[],
  unchecked: UncheckedRoute[],
): Finding[] {
  const services = servicesIn(production);
  const deployment = deploymentOf([...production]);
  const findings: Finding[] = [];
  for (const consumer of unpairedConsumers) {
    const binding = consumer.identity.boundaryBinding;
    if (
      binding === null ||
      binding.semantics.name !== "rest" ||
      BOUNDARY_ROLE[consumer.kind] !== "consumer" ||
      !bindingIsItsOwn(consumer)
    ) {
      continue;
    }
    const deployed = deployment(consumer);
    const grounded = groundBinding(binding, deployed);
    const call = fullyReadCall(grounded, consumer);
    if (call === null) {
      continue;
    }
    const target = targetOf(consumer, binding, call, services, deployed);
    if (target.kind === "unsettled") {
      unchecked.push({
        consumer: summaryIdentifier(consumer),
        name: consumer.identity.name,
        call: `${call.method} ${call.path}`,
        reason: target.reason,
      });
      continue;
    }
    if (target.kind === "service") {
      findings.push(
        ...missingRouteFinding(
          consumer,
          binding,
          grounded,
          call,
          target.service,
        ),
      );
    }
  }
  return findings;
}

/**
 * Whether the binding's method and host are the ones the unit sends. A
 * helper that sends whatever its caller passes has its library's default
 * there instead, and each caller is a client of its own.
 */
function bindingIsItsOwn(consumer: BehavioralSummary): boolean {
  const from = consumer.bindingFrom;
  return from?.method === undefined && from?.host === undefined;
}

/**
 * The call's method and path when suss read both in full: a method other
 * than "any", and a path whose every segment is text or a whole-segment
 * parameter, with no base URL left open, no set of texts, and no part
 * from a value suss could not read. Null for anything else, since
 * a path with a piece suss could not read may be one the service serves.
 */
function fullyReadCall(
  grounded: BoundaryBinding,
  consumer: BehavioralSummary,
): RestCall | null {
  const semantics = grounded.semantics;
  if (semantics.name !== "rest") {
    return null;
  }
  const { method, path, host } = semantics;
  if (method === null || method === "*" || path === null) {
    return null;
  }
  if (!path.startsWith("/") || /[()|*]/.test(path)) {
    return null;
  }
  if (!path.split("/").every(segmentFullyRead)) {
    return null;
  }
  if (readHttpMetadata(consumer)?.urlPartUnread === true) {
    return null;
  }
  return host === undefined ? { method, path } : { method, path, host };
}

function segmentFullyRead(segment: string): boolean {
  if (!segment.includes("{")) {
    return !segment.includes("}");
  }
  return /^\{[A-Za-z_$][\w$]*\}$/.test(segment);
}

/**
 * The service a call goes to. A relative URL goes to the service whose
 * code makes the call, and a base URL the deployment fills in goes to
 * the one service that serves routes under the path the base gives. A
 * host written out is another company's API, or a service of this run
 * that nothing ties to a workspace, which leaves the call unsettled, and
 * so does a public host the deployment sets the base to.
 */
function targetOf(
  consumer: BehavioralSummary,
  written: BoundaryBinding,
  call: RestCall,
  services: ReadonlyMap<string, Service>,
  deployed: Deployment,
): Target {
  const semantics = written.semantics;
  if (semantics.name !== "rest" || call.host !== undefined) {
    return ELSEWHERE;
  }
  if (semantics.host !== undefined) {
    return {
      kind: "unsettled",
      reason: `the call names the host ${semantics.host}, which may be a service in this run, and nothing says which one`,
    };
  }
  const base = OPENING_HOLE.exec(semantics.path ?? "");
  if (base === null) {
    return ownService(consumer, services);
  }
  const host = publicHostDeployed(written, deployed);
  if (host !== null) {
    return {
      kind: "unsettled",
      reason: `the deployment sets the base URL to the public host ${host}, which may be another company's API, and nothing says a service in this run serves it`,
    };
  }
  return serviceUnderBase(call.path, base[1] ?? "", services);
}

/** A relative call goes to the service whose code makes it, when that code serves routes. */
function ownService(
  consumer: BehavioralSummary,
  services: ReadonlyMap<string, Service>,
): Target {
  const own = services.get(workspaceOf(consumer));
  if (own === undefined || own.routes.length === 0) {
    return {
      kind: "unsettled",
      reason:
        "the code that makes the call serves no routes, so whatever is in front of it, such as a proxy or a gateway, decides where the call goes",
    };
  }
  return { kind: "service", service: own };
}

/**
 * The host the deployment sets the call's base URL to, when that host
 * cannot be the project's own. A private name, such as `shop.internal`
 * or a container's, is one of the run's services or nothing at all.
 */
function publicHostDeployed(
  written: BoundaryBinding,
  deployed: Deployment,
): string | null {
  const reference = nameReference(written);
  const base = reference === null ? null : deployed.setTo(reference);
  const host = base === null ? undefined : originHost(base);
  return host === undefined || hostCanBeOwn(host) ? null : host;
}

/**
 * The one service that serves routes under the path a base URL gives.
 * `rest` is what the code writes after the base, and `path` is the call
 * with the deployment's value for the base in front of it.
 */
function serviceUnderBase(
  path: string,
  rest: string,
  services: ReadonlyMap<string, Service>,
): Target {
  const after = rest === "" || rest === "/" ? "" : normalizePath(rest);
  const grounded = normalizePath(path);
  if (!grounded.endsWith(after)) {
    return {
      kind: "unsettled",
      reason:
        "the path the code adds to the deployment's base URL could not be told apart from the base",
    };
  }
  const prefix = grounded.slice(0, grounded.length - after.length);
  const serving = [...services.values()].filter((service) =>
    service.routes.some((route) => servesUnder(route, prefix)),
  );
  if (serving.length !== 1) {
    return { kind: "unsettled", reason: baseServedBy(serving.length, prefix) };
  }
  return { kind: "service", service: serving[0] as Service };
}

function baseServedBy(services: number, prefix: string): string {
  const under = prefix === "" ? "/" : prefix;
  if (services === 0) {
    return `no service in this run serves routes under ${under}, where the deployment's base URL points`;
  }
  return `${services} services in this run serve routes under ${under}, where the deployment's base URL points, and nothing says which one the call reaches`;
}

function servesUnder(route: BehavioralSummary, prefix: string): boolean {
  const path = routePath(route);
  if (path === null) {
    return false;
  }
  const normalized = normalizePath(path);
  return (
    prefix === "" ||
    prefix === "/" ||
    normalized === prefix ||
    normalized.startsWith(`${prefix}/`)
  );
}

/**
 * The finding for a call no route in its service can take, or nothing
 * when the service's table is not complete enough to say so.
 */
function missingRouteFinding(
  consumer: BehavioralSummary,
  written: BoundaryBinding,
  grounded: BoundaryBinding,
  call: RestCall,
  service: Service,
): Finding[] {
  if (!tableIsComplete(service) || servedBeside(service, call)) {
    return [];
  }
  const meeting = service.routes.filter((route) => {
    const binding = route.identity.boundaryBinding;
    return binding !== null && bucketsMeet(binding, grounded);
  });
  // A route that meets the call under its method may serve it: the call
  // has a hole where the route writes a segment, and pairing does not
  // guess that the two are equal.
  if (meeting.some((route) => methodsAgree(routeMethod(route), call.method))) {
    return [];
  }
  const otherMethods = [
    ...new Set(meeting.flatMap((route) => routeMethod(route) ?? [])),
  ].sort();
  const nearby = nearbyRoutes(service, meeting, call);
  const said = missingRouteSentence(
    consumer.identity.name,
    call,
    service,
    otherMethods,
  );
  const side = { summary: summaryRef(consumer), location: consumer.location };
  return [
    {
      kind: "restMethodOnUnknownPath",
      boundary: written,
      provider: side,
      consumer: side,
      description:
        nearby.length === 0
          ? said
          : `${said} Routes nearby: ${nearby.join(", ")}.`,
      severity: "error",
      target: { service: service.name, routes: service.routes.length, nearby },
    },
  ];
}

function missingRouteSentence(
  name: string,
  call: RestCall,
  service: Service,
  otherMethods: readonly string[],
): string {
  const calledService =
    service.name === ""
      ? "the service it calls"
      : `${service.name}, the service it calls,`;
  const calls = `${name} calls ${call.method} ${call.path}, and ${calledService}`;
  if (otherMethods.length > 0) {
    return `${calls} serves that path only for ${otherMethods.join(" and ")}. Every ${call.method} to it fails.`;
  }
  return `${calls} does not serve that path. Every call gets a 404.`;
}

/**
 * Whether "no route matches" means the route is not there: every route
 * has a method and a path, none takes every path, and each has its
 * pack's statement of what else serves requests in this service.
 */
function tableIsComplete(service: Service): boolean {
  return service.routes.every((route) => {
    const path = routePath(route);
    const pack = route.identity.boundaryBinding?.recognition;
    return (
      path !== null &&
      routeMethod(route) !== null &&
      pack !== undefined &&
      readServedBesideMetadata(route)?.pack === pack &&
      !isCatchAll(normalizePath(path))
    );
  });
}

function servedBeside(service: Service, call: RestCall): boolean {
  for (const entries of service.beside.values()) {
    if (entries.some((entry) => servesCall(entry, call.method, call.path))) {
      return true;
    }
  }
  return false;
}

/**
 * The routes closest to the call: the ones at its path with another
 * method, then the ones whose path differs from it in one written
 * segment, which is what a rename leaves. Of those, a route with the
 * call's method comes first, then the one whose segment starts the way
 * the call's does, as `impersonate-user` does for `impersonate`.
 */
function nearbyRoutes(
  service: Service,
  meeting: readonly BehavioralSummary[],
  call: RestCall,
): string[] {
  const renamed = service.routes
    .flatMap((route) => {
      const path = routePath(route);
      const differing = path === null ? null : renamedSegment(path, call.path);
      return differing === null
        ? []
        : [{ route, closeness: renameCloseness(route, differing, call) }];
    })
    .sort((a, b) => compareRanks(b.closeness, a.closeness))
    .map(({ route }) => route);
  const labels = [...meeting, ...renamed].map(
    (route) =>
      `${routeMethod(route) ?? "ANY"} ${normalizePath(routePath(route) ?? "")}`,
  );
  return [...new Set(labels)].slice(0, NEARBY_LISTED);
}

function renameCloseness(
  route: BehavioralSummary,
  differing: { route: string; call: string },
  call: RestCall,
): number[] {
  let shared = 0;
  while (
    shared < differing.route.length &&
    differing.route[shared] === differing.call[shared]
  ) {
    shared += 1;
  }
  return [methodsAgree(routeMethod(route), call.method) ? 1 : 0, shared];
}

/** The one written segment a route's path and the call's differ in, or null when they differ in any other way. */
function renamedSegment(
  route: string,
  call: string,
): { route: string; call: string } | null {
  const routeSegments = normalizePath(route).split("/");
  const callSegments = normalizePath(call).split("/");
  if (routeSegments.length !== callSegments.length) {
    return null;
  }
  const differing = routeSegments.flatMap((segment, at) => {
    const other = callSegments[at] as string;
    return segment !== other &&
      !segment.startsWith("{") &&
      !other.startsWith("{")
      ? [{ route: segment, call: other }]
      : [];
  });
  return differing.length === 1 ? (differing[0] ?? null) : null;
}

/** Every workspace's REST routes, with the served-beside statements its packs wrote. */
function servicesIn(
  production: readonly BehavioralSummary[],
): Map<string, Service> {
  const services = new Map<string, Service>();
  const serviceFor = (summary: BehavioralSummary): Service => {
    const name = workspaceOf(summary);
    const known = services.get(name);
    if (known !== undefined) {
      return known;
    }
    const made: Service = { name, routes: [], beside: new Map() };
    services.set(name, made);
    return made;
  };
  const seen = new Set<string>();
  for (const summary of production) {
    if (!isRoute(summary)) {
      continue;
    }
    const service = serviceFor(summary);
    service.routes.push(summary);
    const statement = readServedBesideMetadata(summary);
    const key = JSON.stringify([service.name, statement]);
    if (statement === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    service.beside.set(statement.pack, [
      ...(service.beside.get(statement.pack) ?? []),
      ...statement.entries,
    ]);
  }
  return services;
}

/** A REST route some code in the run serves. A contract document describes one and serves nothing. */
function isRoute(summary: BehavioralSummary): boolean {
  const binding = summary.identity.boundaryBinding;
  return (
    binding !== null &&
    binding.semantics.name === "rest" &&
    BOUNDARY_ROLE[summary.kind] === "provider" &&
    !isContractDocument(summary)
  );
}

function workspaceOf(summary: BehavioralSummary): string {
  return summary.location.workspace ?? "";
}

function routePath(route: BehavioralSummary): string | null {
  const semantics = route.identity.boundaryBinding?.semantics;
  return semantics?.name === "rest" ? semantics.path : null;
}

function routeMethod(route: BehavioralSummary): string | null {
  const semantics = route.identity.boundaryBinding?.semantics;
  return semantics?.name === "rest" ? semantics.method : null;
}
