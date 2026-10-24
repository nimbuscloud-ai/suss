/**
 * Builders for the summaries the map tests run on: routes, the services
 * they call, the tables and variables those touch, and a spec. Each
 * builder writes only the fields the map reads, with the rest set to
 * what an extract writes for a plain unit.
 */

import { checkAll } from "@suss/checker";

import { loadedSummaries } from "../loadedSummaries.js";
import { buildMapModel } from "../map/mapModel.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Predicate,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { MapModel, MapRead } from "../map/mapModel.js";

type Repository = NonNullable<BehavioralSummary["location"]["repository"]>;

export interface UnitOptions {
  kind: BehavioralSummary["kind"];
  file: string;
  name: string;
  line?: number;
  binding?: BoundaryBinding | null;
  transitions?: Transition[];
  gaps?: BehavioralSummary["gaps"];
  repository?: Repository;
  metadata?: Record<string, unknown>;
  definitions?: Record<string, TypeShape>;
  /** Leave the id out, as a contract reader does. */
  noId?: boolean;
}

export function unit(options: UnitOptions): BehavioralSummary {
  const line = options.line ?? 1;
  return {
    kind: options.kind,
    location: {
      file: options.file,
      range: { start: line, end: line + 9 },
      span: { start: line * 100, end: line * 100 + 90 },
      exportName: options.name,
      ...(options.repository === undefined
        ? {}
        : { repository: options.repository }),
    },
    identity: {
      name: options.name,
      exportPath: [options.name],
      boundaryBinding: options.binding ?? null,
      ...(options.noId === true
        ? {}
        : { id: `${options.file}::${options.name}` }),
    },
    inputs: [],
    transitions: options.transitions ?? [transition(`${options.name}:return`)],
    gaps: options.gaps ?? [],
    confidence: { source: "inferred_static", level: "high" },
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.definitions === undefined
      ? {}
      : { definitions: options.definitions }),
  };
}

export function transition(
  id: string,
  options: {
    status?: number;
    effects?: Effect[];
    conditions?: Predicate[];
    line?: number;
    wrapper?: string;
  } = {},
): Transition {
  const line = options.line ?? 2;
  return {
    id,
    conditions: options.conditions ?? [],
    output:
      options.status === undefined
        ? { type: "return", value: null }
        : {
            type: "response",
            statusCode: { type: "literal", value: options.status },
            body: null,
            headers: {},
          },
    effects: options.effects ?? [],
    location: { start: line, end: line },
    isDefault: (options.conditions ?? []).length === 0,
    ...(options.wrapper === undefined
      ? {}
      : {
          metadata: {
            wrappers: { from: { file: "app.ts", name: options.wrapper } },
          },
        }),
  };
}

export function opaque(text: string): Predicate {
  return { type: "opaque", sourceText: text, reason: "complexExpression" };
}

export function tableAccess(
  kind: "read" | "write",
  container: string,
  callee: string,
  line?: number,
): Effect {
  return {
    type: "interaction",
    binding: {
      transport: "postgresql",
      semantics: {
        name: "storage",
        storageSystem: "postgresql",
        scope: "default",
        container,
        accessPath: null,
      },
      recognition: "test-orm",
    },
    callee,
    interaction: { class: "storage-access", kind, fields: [] },
    ...(line === undefined ? {} : { location: { start: line, end: line } }),
  };
}

export function envRead(name: string, defaulted: boolean): Effect {
  return {
    type: "interaction",
    binding: {
      transport: "os",
      semantics: { name: "runtime-config" },
      recognition: "node",
    },
    callee: `process.env.${name}`,
    interaction: { class: "config-read", name, defaulted },
  };
}

export function calls(callee: string, target: BehavioralSummary): Effect {
  return {
    type: "invocation",
    callee,
    summary: target.identity.id ?? "",
    args: [],
    async: false,
  };
}

export function rest(
  method: string,
  path: string,
  recognition = "express",
): BoundaryBinding {
  return {
    transport: "http",
    semantics: { name: "rest", method, path },
    recognition,
  };
}

export function resolver(
  typeName: string,
  fieldName: string,
  recognition = "apollo",
): BoundaryBinding {
  return {
    transport: "http-graphql",
    semantics: { name: "graphql-resolver", typeName, fieldName },
    recognition,
  };
}

/** The model for these summaries, read as one file of code and, when given, one spec. */
export function modelOf(
  code: BehavioralSummary[],
  spec: BehavioralSummary[] = [],
): MapModel {
  const reads: MapRead[] = [
    {
      file: "code.json",
      label: "code.json",
      root: "/work/shop",
      packs: [],
      spec: false,
    },
    ...(spec.length > 0
      ? [
          {
            file: "spec.json",
            label: "spec.json",
            root: "/work/shop",
            packs: [],
            spec: true,
          },
        ]
      : []),
  ];
  const summaries = [...code, ...spec];
  const readOf = new Map<BehavioralSummary, number>([
    ...code.map((s): [BehavioralSummary, number] => [s, 0]),
    ...spec.map((s): [BehavioralSummary, number] => [s, 1]),
  ]);
  return buildMapModel({
    projectName: "shop",
    loaded: loadedSummaries(summaries),
    check: checkAll(summaries),
    reads,
    readOf,
  });
}
