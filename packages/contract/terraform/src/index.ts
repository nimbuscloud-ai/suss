/**
 * The boundaries a Terraform configuration declares.
 *
 * This reads HCL and matches what it finds against the packs a run
 * loads. A pack says what `aws_dynamodb_table` is; nothing about any
 * provider is written here.
 *
 * A name is usually built at deploy time, and Terraform interpolates
 * the same way CloudFormation does, so `"${local.environment}-orders"`
 * becomes the pattern `{local.environment}-orders` and pairs with code
 * that builds the same name from its own variable. An interpolation
 * that refers to another resource in the same configuration resolves
 * instead, since that resource states the value. The README says how a
 * block that HCL states once or many times is read.
 */

import fs from "node:fs";
import path from "node:path";

// The parser ships CommonJS, so ESM reaches it through the default.
import hcl2 from "hcl2-parser";
import semver from "semver";

import {
  messageBusBinding,
  metricBinding,
  namePatternFromSub,
  storageBinding,
} from "@suss/behavioral-ir";

import { filterValuesFor, parseFilterQuery } from "./filterQuery.js";
import { referenceScope, resolveReferences } from "./references.js";

import type {
  BehavioralSummary,
  MetricContractMetadata,
  MetricReadingMetadata,
} from "@suss/behavioral-ir";
import type {
  AttributeMeaning,
  MessageBusResource,
  MetricReadingResource,
  MetricResource,
  StorageResource,
  TerraformPack,
  TerraformResource,
  TerraformResourcePattern,
} from "./pack.js";
import type { ReferenceScope } from "./references.js";

export {
  type FilterCall,
  type FilterParse,
  type FilterQuery,
  type FilterTerm,
  filterCalls,
  filterTerms,
  filterValuesFor,
  parseFilterQuery,
} from "./filterQuery.js";

export type {
  AttributeMeaning,
  MessageBusResource,
  MetricReadingResource,
  MetricResource,
  StorageResource,
  TerraformPack,
  TerraformResource,
  TerraformResourcePattern,
} from "./pack.js";

export interface TerraformReadOptions {
  /** The packs that say what this configuration's resources are. */
  packs: TerraformPack[];
}

interface KeyedShape {
  /** The block this describes, or null for the resource's own key. */
  accessPath: string | null;
  keyFields: string[];
  /**
   * Every field this can serve, for a way in that copies part of an
   * item. Null when it serves whatever the item has, which is what the
   * container itself does.
   */
  serves: string[] | null;
}

/** Every boundary one Terraform configuration declares. */
export function terraformToSummaries(
  source: string,
  sourceFile: string,
  options: TerraformReadOptions,
): BehavioralSummary[] {
  return summariesForFiles([{ source, sourceFile }], options);
}

/** Read one `.tf` file, or every one directly inside a directory. */
export function terraformFileToSummaries(
  target: string,
  options: TerraformReadOptions,
): BehavioralSummary[] {
  const files = fs.statSync(target).isDirectory()
    ? fs
        .readdirSync(target)
        .filter((name) => name.endsWith(".tf"))
        .map((name) => path.join(target, name))
    : [target];
  return summariesForFiles(
    files.map((file) => ({
      source: fs.readFileSync(file, "utf8"),
      sourceFile: file,
    })),
    options,
  );
}

/** One `.tf` file, as it was read off disk. */
interface SourceFile {
  source: string;
  sourceFile: string;
}

/** What one file states, once the parser has been through it. */
interface ParsedFile {
  sourceFile: string;
  constraints: Map<string, string>;
  resources: Array<[string, string, Record<string, unknown>]>;
}

/**
 * The boundaries a set of files declares, read as one configuration. A
 * module states its resources across several files and a reference in
 * one of them may refer to a resource another one states, so every file
 * being read contributes to the scope references resolve against.
 */
function summariesForFiles(
  files: SourceFile[],
  options: TerraformReadOptions,
): BehavioralSummary[] {
  const parsed = files
    .map((file) => parseSource(file))
    .filter((file): file is ParsedFile => file !== null);
  const scope = referenceScope(parsed.flatMap((file) => file.resources));

  const summaries: BehavioralSummary[] = [];
  for (const file of parsed) {
    for (const [resourceType, label, body] of file.resources) {
      for (const pack of options.packs) {
        const pattern = patternFor(pack, resourceType, file.constraints);
        if (pattern === undefined) {
          continue;
        }
        summaries.push(
          ...summariesFor({
            pattern,
            label,
            body,
            sourceFile: file.sourceFile,
            resourceType,
            scope,
          }),
        );
      }
    }
  }
  return summaries;
}

/** What one file states, or null when the parser could not read it. */
function parseSource(file: SourceFile): ParsedFile | null {
  let read: unknown;
  try {
    // The parser gives back what it read and what stopped it, and a
    // file it could not read comes back as nothing.
    const [parsed] = hcl2.parseToObject(file.source);
    read = parsed;
  } catch {
    return null;
  }
  const document = asRecord(read);
  if (document === null) {
    return null;
  }
  return {
    sourceFile: file.sourceFile,
    constraints: providerConstraints(document),
    resources: resourcesIn(document),
  };
}

/**
 * The version each provider is pinned to, by the name
 * `required_providers` gives it. A configuration that pins nothing says
 * nothing, and an entry is then read whatever version it describes.
 */
function providerConstraints(
  document: Record<string, unknown>,
): Map<string, string> {
  const constraints = new Map<string, string>();
  for (const block of arrayOf(document.terraform)) {
    for (const required of arrayOf(asRecord(block)?.required_providers)) {
      const declared = asRecord(required);
      if (declared === null) {
        continue;
      }
      for (const [provider, spec] of Object.entries(declared)) {
        for (const entry of arrayOf(spec)) {
          const version = stringOf(asRecord(entry)?.version);
          if (version !== null) {
            constraints.set(provider, version);
          }
        }
      }
    }
  }
  return constraints;
}

/**
 * The entry a pack has for this resource type, when the configuration's
 * own provider pin allows it. A pin outside the entry's range means the
 * entry describes a different version of the provider, so it says
 * nothing about this configuration.
 */
function patternFor(
  pack: TerraformPack,
  resourceType: string,
  constraints: Map<string, string>,
): TerraformResourcePattern | undefined {
  const pinned = constraints.get(pack.provider);
  return pack.resources.find((pattern) => {
    if (pattern.resource !== resourceType) {
      return false;
    }
    if (pinned === undefined) {
      return true;
    }
    try {
      return semver.intersects(pinned, pattern.providerVersions, {
        loose: true,
      });
    } catch {
      // A pin nobody can read settles nothing, so the entry is read.
      return true;
    }
  });
}

/** Where in the configuration one resource was written. */
interface ResourceSite {
  label: string;
  body: Record<string, unknown>;
  sourceFile: string;
  resourceType: string;
  /** What the rest of the configuration states, for a reference in it. */
  scope: ReferenceScope;
}

/** One reader per kind of thing a pack entry can say a resource is. */
type ResourceReaders = {
  [K in TerraformResource["kind"]]: (
    site: ResourceSite,
    boundary: Extract<TerraformResource, { kind: K }>,
  ) => BehavioralSummary[];
};

const READERS: ResourceReaders = {
  storage: (site, boundary) => {
    const types = fieldTypes(site.body, boundary);
    return keyedShapes(site.body, boundary).map((shape) =>
      storageSummary({ ...site, boundary, shape, types }),
    );
  },
  "message-bus": (site, boundary) => [busSummary({ ...site, boundary })],
  metric: (site, boundary) => [metricSummary({ ...site, boundary })],
  "metric-reading": (site, boundary) => readingSummaries({ ...site, boundary }),
};

function summariesFor(
  opts: ResourceSite & { pattern: TerraformResourcePattern },
): BehavioralSummary[] {
  const { pattern, ...site } = opts;
  // The one cast joining a table that narrows per kind to a lookup that
  // does not, the way `dispatchByType` does it for the IR's own unions.
  const read = READERS[pattern.boundary.kind] as (
    site: ResourceSite,
    boundary: TerraformResource,
  ) => BehavioralSummary[];
  return read(site, pattern.boundary);
}

function storageSummary(
  opts: ResourceSite & {
    boundary: StorageResource;
    shape: KeyedShape;
    types: Map<string, string>;
  },
): BehavioralSummary {
  const { boundary, label, shape, types } = opts;
  // Two resource types may share a label, so the summary goes by the
  // address Terraform itself refers to a resource by.
  const address = `${opts.resourceType}.${label}`;
  const physicalTable =
    boundary.nameAttribute === undefined
      ? null
      : namePattern(opts.body[boundary.nameAttribute], opts.scope);

  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name:
        shape.accessPath === null ? address : `${address}#${shape.accessPath}`,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "terraform",
        storageSystem: boundary.storageSystem,
        ...(boundary.transport !== undefined
          ? { transport: boundary.transport }
          : {}),
        scope: "default",
        container: label,
        accessPath: shape.accessPath,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        // A way in that copies part of an item has every field it will
        // ever have, whatever the container itself stores.
        fieldSet: shape.serves === null ? boundary.fieldSet : "exhaustive",
        ...(boundary.identifies === undefined
          ? {}
          : {
              identifies: { kind: "keyFields", fields: shape.keyFields },
              fields: (shape.serves ?? shape.keyFields).map((field) => ({
                name: field,
                ...(types.has(field) ? { type: types.get(field) } : {}),
                ...(shape.keyFields.includes(field) ? { primary: true } : {}),
              })),
            }),
        ...(physicalTable !== null ? { physicalTable } : {}),
      },
    },
  };
}

function busSummary(
  opts: ResourceSite & { boundary: MessageBusResource },
): BehavioralSummary {
  const { boundary, label } = opts;
  const physicalName =
    boundary.nameAttribute === undefined
      ? null
      : namePattern(opts.body[boundary.nameAttribute], opts.scope);

  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: `${opts.resourceType}.${label}`,
      exportPath: null,
      boundaryBinding: messageBusBinding({
        recognition: "terraform",
        messageBus: boundary.messageBus,
        channel: label,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      messageBus: {
        ...(physicalName !== null ? { physicalName } : {}),
        ...(opts.body.fifo_queue === true ? { fifoQueue: true } : {}),
        ...(opts.body.fifo_topic === true ? { fifoTopic: true } : {}),
      },
    },
  };
}

/** Where a metric type template leaves room for the declared name. */
const NAME_HOLE = "{name}";

function metricSummary(
  opts: ResourceSite & { boundary: MetricResource },
): BehavioralSummary {
  const { boundary } = opts;
  const declaredName = namePattern(
    opts.body[boundary.nameAttribute],
    opts.scope,
  );
  const metricType =
    declaredName === null
      ? null
      : boundary.metricTypeTemplate.replace(NAME_HOLE, declaredName);
  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: `${opts.resourceType}.${opts.label}`,
      exportPath: null,
      boundaryBinding: metricBinding({
        recognition: "terraform",
        metricSystem: boundary.metricSystem,
        metricType,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: { metricContract: metricContract(opts.body, boundary) },
  };
}

/** What the resource says its measurements are, in suss's own words. */
function metricContract(
  body: Record<string, unknown>,
  boundary: MetricResource,
): MetricContractMetadata {
  const values = meaningOf(body, boundary.values);
  const accumulates = meaningOf(body, boundary.accumulates);
  return {
    ...(values !== undefined ? { values } : {}),
    ...(accumulates !== undefined ? { accumulates } : {}),
  };
}

/**
 * One summary per metric a resource reads. A reading whose query this
 * could not read, or which states no metric, still becomes a summary,
 * with no metric type on it: a resource watching something nobody can
 * spell is worth seeing, and it pairs with nothing.
 */
function readingSummaries(
  opts: ResourceSite & { boundary: MetricReadingResource },
): BehavioralSummary[] {
  const { boundary } = opts;
  const summaries: BehavioralSummary[] = [];
  for (const reading of blocksAt(opts.body, boundary.readingBlocks)) {
    const query = stringOf(valueAt(reading, boundary.queryAttribute));
    for (const metricType of metricTypesIn(
      query,
      boundary.queryIdentityKey,
      opts.scope,
    )) {
      summaries.push({
        kind: "consumer",
        location: {
          file: opts.sourceFile,
          range: { start: 1, end: 1 },
          exportName: null,
        },
        identity: {
          name: `${opts.resourceType}.${opts.label}#${summaries.length}`,
          exportPath: null,
          boundaryBinding: metricBinding({
            recognition: "terraform",
            metricSystem: boundary.metricSystem,
            metricType,
          }),
        },
        inputs: [],
        transitions: [],
        gaps: [],
        confidence: { source: "declared", level: "high" },
        metadata: { metricReading: metricReading(reading, boundary) },
      });
    }
  }
  return summaries;
}

/**
 * Every metric a query says it is about, or one null when the query is
 * missing, unreadable, or has no value under this key.
 */
function metricTypesIn(
  query: string | null,
  identityKey: string,
  scope: ReferenceScope,
): Array<string | null> {
  if (query === null) {
    return [null];
  }
  const parsed = parseFilterQuery(query);
  if (!parsed.ok) {
    return [null];
  }
  const found = filterValuesFor(parsed.query, identityKey)
    .map((value) => namePattern(value, scope))
    .filter((value): value is string => value !== null);
  return found.length === 0 ? [null] : found;
}

/**
 * What one reading needs from the series, in suss's own words, plus the
 * setting a fix would be written in. The table goes through as the pack
 * wrote it, so a pack states its aligners once and a finding can name
 * the ones that would help without knowing Google.
 */
function metricReading(
  reading: Record<string, unknown>,
  boundary: MetricReadingResource,
): MetricReadingMetadata {
  const compares = boundary.comparesTo;
  const comparesTo =
    compares !== undefined && valueAt(reading, compares.attribute) !== undefined
      ? compares.whenSet
      : undefined;
  const reduces = boundary.reducesTo;
  const reducesTo = meaningOf(reading, reduces);
  return {
    ...(comparesTo !== undefined ? { comparesTo } : {}),
    ...(reducesTo !== undefined ? { reducesTo } : {}),
    ...(reduces === undefined
      ? {}
      : { reduction: { setting: reduces.attribute, leaves: reduces.means } }),
  };
}

/**
 * What the pack says the value at that attribute means, or undefined
 * when the resource states nothing there, or states something the pack
 * does not list.
 */
function meaningOf<T extends string>(
  body: Record<string, unknown>,
  spec: AttributeMeaning<T> | undefined,
): T | undefined {
  if (spec === undefined) {
    return undefined;
  }
  const stated = stringOf(valueAt(body, spec.attribute));
  return stated === null ? undefined : spec.means[stated];
}

/**
 * The value at a dotted path, stepping into a block on the way. A block
 * HCL states once and a block it states many times both arrive as a
 * list, and a path takes the first, since a path is about one value.
 */
function valueAt(body: Record<string, unknown>, path: string): unknown {
  const steps = path.split(".");
  const last = steps.pop() as string;
  let current: Record<string, unknown> | null = body;
  for (const step of steps) {
    const nested = arrayOf(current[step])[0];
    current = asRecord(nested);
    if (current === null) {
      return undefined;
    }
  }
  return current[last];
}

/** Every block at the end of a chain of nested block names. */
function blocksAt(
  body: Record<string, unknown>,
  blocks: string[],
): Array<Record<string, unknown>> {
  let found: Array<Record<string, unknown>> = [body];
  for (const block of blocks) {
    found = found.flatMap((record) =>
      arrayOf(record[block])
        .map(asRecord)
        .filter((nested): nested is Record<string, unknown> => nested !== null),
    );
  }
  return found;
}

/**
 * The resource's own key, then one entry per block that declares
 * another way in. A resource whose entry states no keys has one shape
 * and no key fields, which is what a bucket is.
 */
function keyedShapes(
  body: Record<string, unknown>,
  boundary: StorageResource,
): KeyedShape[] {
  if (boundary.identifies === undefined) {
    return [{ accessPath: null, keyFields: [], serves: null }];
  }
  const ownKeys = keyFields(body, boundary.identifies);
  const shapes: KeyedShape[] = [
    { accessPath: null, keyFields: ownKeys, serves: null },
  ];
  for (const block of boundary.accessPathBlocks ?? []) {
    for (const declared of arrayOf(body[block])) {
      const index = asRecord(declared);
      const indexName = index === null ? null : stringOf(index.name);
      if (index === null || indexName === null) {
        continue;
      }
      const indexKeys = keyFields(index, boundary.identifies);
      shapes.push({
        accessPath: indexName,
        keyFields: indexKeys,
        serves: servedFields(index, boundary, [...indexKeys, ...ownKeys]),
      });
    }
  }
  return shapes;
}

/**
 * Every field a way in can serve, or null when it serves whatever the
 * item has. A store always sends the keys, its own and the container's,
 * so those count as served however narrow the copy is.
 */
function servedFields(
  block: Record<string, unknown>,
  boundary: StorageResource,
  keys: string[],
): string[] | null {
  const spec = boundary.serves;
  if (spec === undefined) {
    return null;
  }
  const kind = stringOf(block[spec.kindAttribute]);
  if (kind === null || kind === spec.everything) {
    return null;
  }
  const listed = arrayOf(block[spec.fieldsAttribute]).flatMap((entry) =>
    Array.isArray(entry) ? entry : [entry],
  );
  const named = listed.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return [...new Set([...keys, ...named])];
}

/**
 * The keys a block states, in the order the entry lists them. DynamoDB
 * takes them that way, so a caller that supplies the sort key without
 * the partition key has supplied neither.
 */
function keyFields(
  block: Record<string, unknown>,
  attributes: string[],
): string[] {
  return attributes
    .map((attribute) => stringOf(block[attribute]))
    .filter((field): field is string => field !== null);
}

/** The type each field block gives, by field name. */
function fieldTypes(
  body: Record<string, unknown>,
  boundary: StorageResource,
): Map<string, string> {
  const types = new Map<string, string>();
  const spec = boundary.fieldTypes;
  if (spec === undefined) {
    return types;
  }
  for (const declared of arrayOf(body[spec.block])) {
    const field = asRecord(declared);
    if (field === null) {
      continue;
    }
    const name = stringOf(field[spec.nameAttribute]);
    const type = stringOf(field[spec.typeAttribute]);
    if (name !== null && type !== null) {
      types.set(name, type);
    }
  }
  return types;
}

/** Every resource a configuration states, as `[type, label, body]`. */
function resourcesIn(
  document: Record<string, unknown>,
): Array<[string, string, Record<string, unknown>]> {
  const found: Array<[string, string, Record<string, unknown>]> = [];
  for (const resource of arrayOf(document.resource)) {
    const byType = asRecord(resource);
    if (byType === null) {
      continue;
    }
    for (const [resourceType, labelled] of Object.entries(byType)) {
      for (const group of arrayOf(labelled)) {
        const byLabel = asRecord(group);
        if (byLabel === null) {
          continue;
        }
        for (const [label, bodies] of Object.entries(byLabel)) {
          for (const body of arrayOf(bodies)) {
            const read = asRecord(body);
            if (read !== null) {
              found.push([resourceType, label, read]);
            }
          }
        }
      }
    }
  }
  return found;
}

/**
 * The name a value states. A reference to a resource this configuration
 * states is read as that resource's value rather than as a hole.
 */
function namePattern(value: unknown, scope: ReferenceScope): string | null {
  return namePatternFromSub(
    typeof value === "string" ? resolveReferences(value, scope) : value,
  );
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
