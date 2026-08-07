// mountPrefix.ts, composing a mounted router's routes with the prefix
// they were mounted under.
//
// Express's `app.use(prefix, router)` and Hono's `app.route(prefix,
// sub)` register a sub-router under a literal path segment, and a
// route declared on that sub-router answers to the combined path, not
// the one written at its own registration call. The sub-router is
// often built in a different file than the one that mounts it
// (app.ts imports a router from routes/ordersRouter.ts and mounts it
// there), so finding the prefix a route belongs to means asking the
// resolution store the same question `registrationCall` already asks
// about a handler: what value does this argument name, followed
// wherever that takes it.
//
// Built once per extraction, over every file a pack's own gate already
// applies to, so a project with no mountable pack pays nothing extra.

import { nodeId } from "../facts/extract.js";
import {
  discoverMountEdges,
  joinMountedPath,
  type MountEdgeCandidate,
  type MountPrefixIndex,
  registrationSubjectIdsOf,
} from "./registrationCall.js";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";
import type { Node, SourceFile } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

export type { MountPrefixIndex } from "./registrationCall.js";

interface MountEdge {
  parentId: string;
  prefix: string;
}

const NO_MOUNTS: MountPrefixIndex = { effectivePrefixFor: () => "" };

type RegistrationMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationCall" }
>;

interface MountPattern {
  match: RegistrationMatch;
  mount: NonNullable<DiscoveryPattern["mount"]>;
}

interface PackMountWork {
  sourceFile: SourceFile;
  match: RegistrationMatch;
  mount: NonNullable<DiscoveryPattern["mount"]>;
}

/**
 * Scan every file a pack's discovery gate already applies to for mount
 * calls the pack declares through `DiscoveryPattern.mount`, and build
 * the index route discovery composes paths through.
 */
export function buildMountPrefixIndex(
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>,
  resolution: ResolutionStore,
): MountPrefixIndex {
  // First pass: for each pack (keyed by name, the identity the rest of
  // the adapter already uses for a pack), the project-wide set of
  // every registration subject's creation site that pack's own
  // patterns track, and every mount call site that pack declares.
  // Scoped per pack rather than pooled across every active pack,
  // because a mount only ever mounts a value the same pack builds: an
  // Express `.use` can't run a Hono app as a sub-router, so a target
  // resolving into another pack's subjects is not a mount at all, and
  // checking against a pooled registry would accept it as one.
  const subjectIdsByPack = new Map<string, Set<string>>();
  const mountWorkByPack = new Map<string, PackMountWork[]>();

  for (const [sourceFile, packs] of packsByFile) {
    for (const pack of packs) {
      const registrationMatches: RegistrationMatch[] = [];
      const mountPatterns: MountPattern[] = [];
      for (const pattern of pack.discovery) {
        if (pattern.match.type !== "registrationCall") {
          continue;
        }
        registrationMatches.push(pattern.match);
        if (pattern.mount !== undefined) {
          mountPatterns.push({ match: pattern.match, mount: pattern.mount });
        }
      }
      if (registrationMatches.length === 0) {
        continue;
      }

      const subjectIds = subjectIdsByPack.get(pack.name) ?? new Set<string>();
      for (const id of registrationSubjectIdsOf(
        sourceFile,
        registrationMatches,
      )) {
        subjectIds.add(id);
      }
      subjectIdsByPack.set(pack.name, subjectIds);

      if (mountPatterns.length === 0) {
        continue;
      }
      const work = mountWorkByPack.get(pack.name) ?? [];
      for (const { match, mount } of mountPatterns) {
        work.push({ sourceFile, match, mount });
      }
      mountWorkByPack.set(pack.name, work);
    }
  }

  // Second pass: scan for mount calls, one pack's own registry at a
  // time, now that subjectIdsByPack holds every file's subjects for
  // each pack.
  const edgesByChild = new Map<string, MountEdge[]>();
  for (const [packName, work] of mountWorkByPack) {
    const knownSubjectIds = subjectIdsByPack.get(packName) ?? new Set<string>();
    for (const { sourceFile, match, mount } of work) {
      for (const candidate of discoverMountEdges(
        sourceFile,
        match,
        mount,
        knownSubjectIds,
        resolution,
      )) {
        recordEdge(edgesByChild, candidate);
      }
    }
  }

  if (edgesByChild.size === 0) {
    return NO_MOUNTS;
  }

  const memo = new Map<string, string | null>();
  return {
    effectivePrefixFor(routerNode: Node): string {
      return (
        resolvePrefix(edgesByChild, memo, nodeId(routerNode), new Set()) ?? ""
      );
    },
  };
}

function recordEdge(
  edgesByChild: Map<string, MountEdge[]>,
  candidate: MountEdgeCandidate,
): void {
  const edges = edgesByChild.get(candidate.childRouterId) ?? [];
  edges.push({ parentId: candidate.parentRouterId, prefix: candidate.prefix });
  edgesByChild.set(candidate.childRouterId, edges);
}

/**
 * The prefix routes on `childId` answer to, composed through however
 * many routers it was mounted onto in turn. `null` means unresolvable
 * rather than "no prefix": a cycle has nothing sane to compose, and a
 * router mounted more than once doesn't settle which prefix a route
 * under it actually takes unless every mount, once each one's own
 * ancestor chain is fully resolved, agrees on the same answer.
 *
 * Agreement is checked on the resolved result, not the literal prefix
 * a mount call states. Two mounts naming the identical local prefix
 * can still land at different full paths if one mount's own router is
 * itself mounted somewhere the other isn't (`app1.use("/api", r)`
 * where `app1` is mounted under `/v1`, next to `app2.use("/api", r)`
 * where `app2` is not mounted anywhere composes `/v1/api` for one and
 * `/api` for the other), and picking one of those arbitrarily would be
 * a wrong answer stated as a right one. Comparing full resolutions
 * catches that; comparing the literal prefixes a mount call states
 * would not.
 */
function resolvePrefix(
  edgesByChild: ReadonlyMap<string, MountEdge[]>,
  memo: Map<string, string | null>,
  childId: string,
  visiting: Set<string>,
): string | null {
  const cached = memo.get(childId);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(childId)) {
    memo.set(childId, null);
    return null;
  }

  const edges = edgesByChild.get(childId);
  if (edges === undefined || edges.length === 0) {
    memo.set(childId, "");
    return "";
  }

  visiting.add(childId);
  let resolved: string | undefined;
  let disagrees = false;
  for (const edge of edges) {
    const parentPrefix = resolvePrefix(
      edgesByChild,
      memo,
      edge.parentId,
      visiting,
    );
    if (parentPrefix === null) {
      disagrees = true;
      break;
    }
    const candidate = joinMountedPath(parentPrefix, edge.prefix);
    if (resolved === undefined) {
      resolved = candidate;
    } else if (resolved !== candidate) {
      disagrees = true;
      break;
    }
  }
  visiting.delete(childId);

  const result = disagrees || resolved === undefined ? null : resolved;
  memo.set(childId, result);
  return result;
}
