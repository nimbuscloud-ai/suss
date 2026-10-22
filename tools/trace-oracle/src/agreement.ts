/**
 * Whether a boundary suss recorded and a target a span recorded are the
 * same thing.
 *
 * Each protocol compares through `semconvAttributes`, the projection
 * suss already keeps for joining a summary against a trace. Two
 * allowances are made, and the report counts each use. A store's system
 * has more than one spelling (`postgres`, `postgresql`). And an ORM pack
 * records the model a query runs against while a span records the
 * table, so a container agrees with a table when the two are the same
 * word after case, underscores and a plural ending are set aside:
 * `Story` and `stories`, `HiddenStory` and `hidden_stories`.
 */

import { semconvAttributes } from "@suss/behavioral-ir";
import { methodsAgree, routePathsMeet } from "@suss/ir-core";

import type { BoundaryBinding } from "@suss/behavioral-ir";
import type { EdgeKind, Target } from "./edges.js";

export type Agreement = "exact" | "byName" | null;

const SYSTEM_SPELLINGS: Record<string, string> = {
  postgres: "postgresql",
  pg: "postgresql",
  sqlite3: "sqlite",
  mariadb: "mysql",
};

export function sameSystem(a: string, b: string): boolean {
  const canonical = (name: string): string =>
    SYSTEM_SPELLINGS[name.toLowerCase()] ?? name.toLowerCase();
  return canonical(a) === canonical(b);
}

/** A name with case, separators and a plural ending set aside, for comparing a model with its table. */
export function nameKey(name: string): string {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (flat.endsWith("ies") && flat.length > 4) {
    return `${flat.slice(0, -3)}y`;
  }
  if (/(ss|us|is)$/.test(flat)) {
    return flat;
  }
  if (/(sses|xes|ches|shes)$/.test(flat)) {
    return flat.slice(0, -2);
  }
  return flat.endsWith("s") ? flat.slice(0, -1) : flat;
}

export function namesAgree(written: string, observed: string): Agreement {
  if (written === observed) {
    return "exact";
  }
  return nameKey(written) === nameKey(observed) ? "byName" : null;
}

/** The protocol a binding has to speak for a target of each kind. */
export const SEMANTICS_FOR: Record<EdgeKind, string> = {
  storage: "storage",
  http: "rest",
  messaging: "message-bus",
};

const AGREEMENT: {
  [K in EdgeKind]: (
    attributes: Record<string, string>,
    binding: BoundaryBinding,
    target: Extract<Target, { kind: K }>,
  ) => Agreement;
} = {
  storage: (attributes, _binding, target) => {
    const system = attributes["db.system.name"];
    const container = attributes["db.collection.name"];
    if (system === undefined || container === undefined) {
      return null;
    }
    return sameSystem(system, target.system)
      ? namesAgree(container, target.table)
      : null;
  },
  http: (attributes, binding, target) => {
    const path = attributes["http.route"];
    const host = (binding.semantics as { host?: string }).host;
    if (path === undefined) {
      return null;
    }
    if (host !== undefined && host.split(":")[0] !== target.host) {
      return null;
    }
    const method = attributes["http.request.method"] ?? null;
    return methodsAgree(method ?? "*", target.method) &&
      routePathsMeet(path, target.path)
      ? "exact"
      : null;
  },
  messaging: (attributes, _binding, target) => {
    const destination = attributes["messaging.destination.name"];
    return destination === target.destination ? "exact" : null;
  },
};

export function agreement(binding: BoundaryBinding, target: Target): Agreement {
  if (binding.semantics.name !== SEMANTICS_FOR[target.kind]) {
    return null;
  }
  return AGREEMENT[target.kind](
    semconvAttributes(binding),
    binding,
    target as never,
  );
}

/** Whether a binding speaks the target's protocol on the target's system, whatever container it gives. */
export function sameStore(binding: BoundaryBinding, target: Target): boolean {
  if (binding.semantics.name !== SEMANTICS_FOR[target.kind]) {
    return false;
  }
  if (target.kind === "storage") {
    const system = (binding.semantics as { storageSystem?: string })
      .storageSystem;
    return system !== undefined && sameSystem(system, target.system);
  }
  return true;
}

/** Whether the binding leaves out the name a span would give: a null container, channel or path, or one with a hole in it. */
export function unsettled(binding: BoundaryBinding, kind: EdgeKind): boolean {
  const attributes = semconvAttributes(binding);
  const name = NAME_ATTRIBUTE[kind];
  const value = attributes[name];
  return value === undefined || value.includes("{");
}

const NAME_ATTRIBUTE: Record<EdgeKind, string> = {
  storage: "db.collection.name",
  http: "http.route",
  messaging: "messaging.destination.name",
};
