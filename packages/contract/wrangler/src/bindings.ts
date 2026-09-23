/**
 * The stores and queues a Worker is bound to, as boundary summaries.
 *
 * Every binding block in a Wrangler document has two parts: `binding`,
 * the name the code reads the resource under, and a key with the
 * resource's own name. Code only ever uses the first (`env.SESSIONS`),
 * so the binding name becomes the container the storage check pairs
 * on, and the resource's own name goes on `physicalTable`.
 */

import { messageBusBinding, storageBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { WranglerRecord } from "./document.js";

/** The manifest language recorded on every binding this reader writes. */
export const RECOGNITION = "wrangler";

/** How one kind of Cloudflare store appears in a Wrangler document. */
interface StoreShape {
  /** The Wrangler block that lists these bindings. */
  block: "kv_namespaces" | "r2_buckets" | "d1_databases";
  /** The key inside the block that gives the resource's own name. */
  nameKey: string;
  /** The store, as a storage binding spells it. */
  storageSystem: string;
  /**
   * KV and R2 store opaque values, so neither declares a field. D1 is
   * SQL, but its schema is in a migration this reader does not read.
   */
  fieldSet: "partial" | "none";
}

const STORES: StoreShape[] = [
  {
    block: "kv_namespaces",
    nameKey: "id",
    storageSystem: "cloudflare-kv",
    fieldSet: "none",
  },
  {
    block: "r2_buckets",
    nameKey: "bucket_name",
    storageSystem: "r2",
    fieldSet: "none",
  },
  {
    block: "d1_databases",
    nameKey: "database_name",
    storageSystem: "d1",
    fieldSet: "partial",
  },
];

export interface BindingContext {
  sourceFile: string;
  /** The Worker these bindings belong to, for the summary's name. */
  scriptName: string;
}

/** Every store summary a document's binding blocks declare. */
export function storeSummaries(
  document: Record<string, unknown>,
  context: BindingContext,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  for (const store of STORES) {
    for (const entry of blockEntries(document[store.block])) {
      const summary = storeSummary(store, entry, context);
      if (summary !== null) {
        summaries.push(summary);
      }
    }
  }
  return summaries;
}

function storeSummary(
  store: StoreShape,
  entry: WranglerRecord,
  context: BindingContext,
): BehavioralSummary | null {
  const resourceName = stringOf(entry[store.nameKey]);
  const boundAs = stringOf(entry.binding);
  if (resourceName === null) {
    return null;
  }
  return {
    kind: "library",
    location: {
      file: context.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: `${store.block}.${boundAs ?? resourceName}`,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: store.storageSystem,
        scope: "default",
        // An access in the Worker uses the binding name, so the storage
        // check has to pair on it.
        container: boundAs ?? resourceName,
        accessPath: null,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: store.fieldSet,
        physicalTable: resourceName,
      },
      ...(boundAs === null ? {} : { wrangler: { binding: boundAs } }),
    },
  };
}

/**
 * The blocks whose bindings become properties of the env object at
 * runtime. A Worker reads `env.SESSIONS` the same way it reads
 * `env.RETRY_LIMIT`, so the runtime contract lists both, and a read of
 * a binding nobody declared is reported like a read of an unset variable.
 */
export const BINDING_BLOCKS = [
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "queues",
] as const;

export function bindingNames(document: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const store of STORES) {
    for (const entry of blockEntries(document[store.block])) {
      const boundAs = stringOf(entry.binding);
      if (boundAs !== null) {
        names.push(boundAs);
      }
    }
  }
  const queues = asRecord(document.queues);
  for (const entry of blockEntries(queues?.producers)) {
    const boundAs = stringOf(entry.binding);
    if (boundAs !== null) {
      names.push(boundAs);
    }
  }
  return names;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/**
 * Every queue summary a document declares. A producer and a consumer on
 * the same queue are two sides of one channel, so each gets its own
 * summary and the message-bus check pairs them.
 */
export function queueSummaries(
  document: Record<string, unknown>,
  context: BindingContext,
): BehavioralSummary[] {
  const queues = document.queues;
  if (queues === null || typeof queues !== "object") {
    return [];
  }
  const block = queues as Record<string, unknown>;
  return [
    ...queueSide(blockEntries(block.producers), "producers", context),
    ...queueSide(blockEntries(block.consumers), "consumers", context),
  ];
}

function queueSide(
  entries: WranglerRecord[],
  side: "producers" | "consumers",
  context: BindingContext,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  for (const entry of entries) {
    const channel = stringOf(entry.queue);
    if (channel === null) {
      continue;
    }
    summaries.push({
      // A producer block declares a queue the Worker sends to. Nothing
      // runs there, so it is a library. A consumer block means this
      // Worker drains the queue.
      kind: side === "consumers" ? "consumer" : "library",
      location: {
        file: context.sourceFile,
        range: { start: 1, end: 1 },
        exportName: null,
      },
      identity: {
        name:
          side === "consumers"
            ? `${context.scriptName}.queue.${channel}`
            : `queues.producers.${channel}`,
        exportPath: null,
        boundaryBinding: messageBusBinding({
          recognition: RECOGNITION,
          messageBus: "cloudflare-queues",
          channel,
        }),
        ...(side === "consumers"
          ? {
              deployableUnit: {
                deploymentTarget: "worker" as const,
                instanceName: context.scriptName,
              },
            }
          : {}),
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "declared", level: "high" },
      metadata: { messageBus: { queue: channel } },
    });
  }
  return summaries;
}

/** The entries of a binding block, when the document writes one as a list. */
function blockEntries(raw: unknown): WranglerRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is WranglerRecord =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

/** A value the document states as text, or null for anything else. */
export function stringOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
