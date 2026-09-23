/**
 * The boundaries a Terraform configuration declares.
 *
 * This module reads HCL and matches it against the packs a run loads. A
 * pack describes what `aws_dynamodb_table` is, and nothing about any
 * provider is written here.
 *
 * Terraform interpolates the same way CloudFormation does, so
 * `"${local.environment}-orders"` becomes the pattern
 * `{local.environment}-orders` and pairs with code that builds the same
 * name from its own variable. A reference to another resource in the
 * same configuration resolves instead, since that resource writes the
 * value. DESIGN.md covers references, module calls and repeated blocks.
 */

import fs from "node:fs";
import path from "node:path";

import semver from "semver";

import {
  ecsContainerInstanceName,
  hasNameHole,
  messageBusBinding,
  metricBinding,
  namePatternFromSub,
  PLATFORM_INJECTED_ENV_VARS,
  parseHandler,
  runtimeConfigBinding,
  storageBinding,
  withRuntimeContractMetadata,
} from "@suss/behavioral-ir";

import { dynamicBlocks, iteratedRecords } from "./blockExpansion.js";
import { filterValuesFor, parseFilterQuery } from "./filterQuery.js";
import { parseHclDocument } from "./hclDocument.js";
import { arrayOf, asRecord, mapStrings, stringOf } from "./hclValue.js";
import { jsonAttributeValue } from "./jsonAttribute.js";
import {
  referencedResource,
  referenceScope,
  resolveReferences,
} from "./references.js";

import type {
  BehavioralSummary,
  CodeScopeMetadata,
  DeployableUnit,
  EnvVarSource,
  Gap,
  MetricContractMetadata,
  MetricReadingMetadata,
  StorageContractMetadata,
} from "@suss/behavioral-ir";
import type {
  AttributeMeaning,
  DeployableResource,
  EnvDeclaration,
  HandlerSpelling,
  MessageBusResource,
  MetricIdentity,
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
export { jsonAttributeValue } from "./jsonAttribute.js";

export type {
  AttributeMeaning,
  DeployableCode,
  DeployableContainers,
  DeployableResource,
  EnvDeclaration,
  HandlerSpelling,
  MessageBusResource,
  MetricIdentity,
  MetricReadingResource,
  MetricResource,
  MetricTypeTemplate,
  StorageResource,
  TerraformPack,
  TerraformResource,
  TerraformResourcePattern,
} from "./pack.js";

export interface TerraformReadOptions {
  /** The packs that describe this configuration's resources. */
  packs: TerraformPack[];
  /**
   * The directory each deployable unit's code is in, by the unit's
   * instance name. A configuration gives the handler that runs but never
   * the directory the artifact was built from, so a container whose
   * image is built elsewhere has no code until the caller gives its
   * location.
   */
  codeScopes?: Record<string, string>;
}

interface KeyedShape {
  /** The block this describes, or null for the resource's own key. */
  accessPath: string | null;
  keyFields: string[];
  /**
   * Every field an access path can return, when it copies only part of
   * an item. Null when it returns the whole item, as the container
   * itself does.
   */
  serves: string[] | null;
}

/** Every boundary one Terraform configuration declares. */
export function terraformToSummaries(
  source: string,
  sourceFile: string,
  options: TerraformReadOptions,
): BehavioralSummary[] {
  return moduleSummaries(
    moduleOf({
      files: [{ source, sourceFile }],
      directory: path.dirname(sourceFile),
      namePrefix: "",
      arguments: {},
      ancestors: [],
    }),
    options,
  );
}

/**
 * Reads one `.tf` file, or every one directly inside a directory, and
 * every local module the configuration calls.
 */
export function terraformFileToSummaries(
  target: string,
  options: TerraformReadOptions,
): BehavioralSummary[] {
  const directory = fs.statSync(target).isDirectory()
    ? target
    : path.dirname(target);
  const files = fs.statSync(target).isDirectory()
    ? sourceFilesIn(target)
    : [readSourceFile(target)];
  return moduleSummaries(
    moduleOf({
      files,
      directory,
      namePrefix: "",
      arguments: {},
      ancestors: [directory],
    }),
    options,
  );
}

/** One `.tf` file, as it was read off disk. */
interface SourceFile {
  source: string;
  sourceFile: string;
}

interface ParsedFile {
  sourceFile: string;
  constraints: Map<string, string>;
  resources: Array<[string, string, Record<string, unknown>]>;
  locals: Array<Record<string, unknown>>;
  /** The `default` each `variable` block states, by variable name. */
  defaults: Record<string, unknown>;
  /** Every child module the file calls, as `[label, arguments]`. */
  modules: Array<[string, Record<string, unknown>]>;
  /** The value of each `output` block, as `[name, value]`. */
  outputs: Array<[string, unknown]>;
}

/** One module the run reads, and every module it calls in turn. */
interface ModuleRead {
  files: ParsedFile[];
  scope: ReferenceScope;
  children: ModuleRead[];
}

/** A `source` that points at a nearby directory with `./` or `../`. */
const LOCAL_SOURCE = /^\.\.?[/\\]/;

/** The `module` attribute that gives the child's location. Every other one is an argument. */
const MODULE_SOURCE = "source";

/**
 * How deep a chain of local modules is followed. Cycles are caught
 * separately, so this only stops an unusually deep tree.
 */
const MODULE_DEPTH_LIMIT = 8;

/** Every `.tf` file directly inside a directory, as it is on disk. */
function sourceFilesIn(directory: string): SourceFile[] {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".tf"))
    .map((name) => readSourceFile(path.join(directory, name)));
}

function readSourceFile(file: string): SourceFile {
  return { source: fs.readFileSync(file, "utf8"), sourceFile: file };
}

/**
 * A reference in one file of a module may point at a resource another
 * file declares, so every file contributes to one scope.
 */
function moduleOf(opts: {
  files: SourceFile[];
  directory: string;
  namePrefix: string;
  arguments: Record<string, unknown>;
  ancestors: string[];
}): ModuleRead {
  const files = opts.files
    .map((file) => parseSource(file))
    .filter((file): file is ParsedFile => file !== null);
  const scope = referenceScope({
    resources: files.flatMap((file) => file.resources),
    locals: files.flatMap((file) => file.locals),
    defaults: Object.assign({}, ...files.map((file) => file.defaults)),
    arguments: opts.arguments,
    namePrefix: opts.namePrefix,
  });

  const children: ModuleRead[] = [];
  for (const [label, call] of files.flatMap((file) => file.modules)) {
    const child = childModule({ ...opts, scope, label, call });
    if (child === null) {
      continue;
    }
    children.push(child);
    // The parent reaches the child only through its outputs, which are
    // resolved already.
    scope.resources.set(`module.${label}`, outputValues(child));
  }
  return { files, scope, children };
}

/**
 * The module one `module` block calls, or null when the run cannot read
 * it. A registry, git or S3 source is not in the repository, and a
 * directory that calls itself back would never finish.
 */
function childModule(opts: {
  directory: string;
  namePrefix: string;
  ancestors: string[];
  scope: ReferenceScope;
  label: string;
  call: Record<string, unknown>;
}): ModuleRead | null {
  const source = stringOf(opts.call[MODULE_SOURCE]);
  if (source === null || !LOCAL_SOURCE.test(source)) {
    return null;
  }
  const directory = path.resolve(opts.directory, source);
  if (
    opts.ancestors.includes(directory) ||
    opts.ancestors.length >= MODULE_DEPTH_LIMIT ||
    !isDirectory(directory)
  ) {
    return null;
  }
  return moduleOf({
    files: sourceFilesIn(directory),
    directory,
    namePrefix: `${opts.namePrefix}module.${opts.label}.`,
    arguments: passedArguments(opts.call, opts.scope),
    ancestors: [...opts.ancestors, directory],
  });
}

function isDirectory(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

/**
 * A string that still has a hole after resolving is not passed, so the
 * child's `${var.x}` stays a hole. A map is passed whole, and DESIGN.md
 * explains how its entries resolve.
 */
function passedArguments(
  call: Record<string, unknown>,
  parent: ReferenceScope,
): Record<string, unknown> {
  const passed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(call)) {
    if (name === MODULE_SOURCE) {
      continue;
    }
    const stated = asRecord(value);
    if (stated !== null) {
      passed[name] = resolvedThroughout(stated, parent);
      continue;
    }
    const written = stringOf(value);
    const settled =
      written === null ? null : resolveReferences(written, parent);
    if (settled !== null && !settled.includes("${")) {
      passed[name] = settled;
    }
  }
  return passed;
}

/** Resolves every reference in a value against the given module's scope. */
function resolvedThroughout(value: unknown, scope: ReferenceScope): unknown {
  const resolveHere = (text: string) => resolveReferences(text, scope);
  return mapStrings(value, resolveHere);
}

/**
 * A child's outputs, resolved in the child's scope. An output that
 * still has a hole is left out, so the parent never pairs on half a name.
 */
function outputValues(child: ModuleRead): Record<string, unknown> {
  const stated: Record<string, unknown> = {};
  for (const [name, value] of child.files.flatMap((file) => file.outputs)) {
    const written = stringOf(value);
    if (written === null || name in stated) {
      continue;
    }
    const settled = resolveReferences(written, child.scope);
    if (!settled.includes("${")) {
      stated[name] = settled;
    }
  }
  return stated;
}

/** Every boundary a module and the modules it calls declare. */
function moduleSummaries(
  module: ModuleRead,
  options: TerraformReadOptions,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  for (const file of module.files) {
    for (const [resourceType, label, body] of file.resources) {
      for (const pack of options.packs) {
        const pattern = patternFor(pack, resourceType, file.constraints, body);
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
            scope: module.scope,
            options,
          }),
        );
      }
    }
  }
  for (const child of module.children) {
    summaries.push(...moduleSummaries(child, options));
  }
  return summaries;
}

/** Null when the parser could not read the file. */
function parseSource(file: SourceFile): ParsedFile | null {
  const document = parseHclDocument(file.source);
  if (document === null) {
    return null;
  }
  return {
    sourceFile: file.sourceFile,
    constraints: providerConstraints(document),
    resources: resourcesIn(document),
    locals: localsIn(document),
    defaults: variableDefaults(document),
    modules: labelledBlocks(document.module),
    outputs: labelledBlocks(document.output).map(([name, block]) => [
      name,
      block.value,
    ]),
  };
}

/** Every labelled block in a document, as `[label, body]`. */
function labelledBlocks(
  declared: unknown,
): Array<[string, Record<string, unknown>]> {
  const found: Array<[string, Record<string, unknown>]> = [];
  for (const group of arrayOf(declared)) {
    for (const [label, bodies] of Object.entries(asRecord(group) ?? {})) {
      for (const body of arrayOf(bodies)) {
        const read = asRecord(body);
        if (read !== null) {
          found.push([label, read]);
        }
      }
    }
  }
  return found;
}

/**
 * Only a `for_each` reads these. A default is what a deployment gets
 * when it passes nothing, which is a guess about what production runs.
 */
function variableDefaults(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const group of arrayOf(document.variable)) {
    for (const [name, declared] of Object.entries(asRecord(group) ?? {})) {
      for (const block of arrayOf(declared)) {
        const stated = asRecord(block)?.default;
        if (stated !== undefined && !(name in defaults)) {
          defaults[name] = stated;
        }
      }
    }
  }
  return defaults;
}

/**
 * The version each provider is pinned to, keyed by its
 * `required_providers` name. With no pin, every entry is read whatever
 * version it describes.
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
 * A pack can have several entries for one resource type, split by
 * provider version or by an `appliesWhen` gate. An entry that is ruled
 * out does not stop a later entry from reading the same resource.
 */
function patternFor(
  pack: TerraformPack,
  resourceType: string,
  constraints: Map<string, string>,
  body: Record<string, unknown>,
): TerraformResourcePattern | undefined {
  const pinned = constraints.get(pack.provider);
  return pack.resources.find(
    (pattern) =>
      pattern.resource === resourceType &&
      versionAllows(pinned, pattern.providerVersions) &&
      entryApplies(pattern, body),
  );
}

/** Whether a configuration's pin and an entry's range have versions in common. */
function versionAllows(
  pinned: string | undefined,
  providerVersions: string,
): boolean {
  if (pinned === undefined) {
    return true;
  }
  try {
    return semver.intersects(pinned, providerVersions, { loose: true });
  } catch {
    // An unparseable pin rules nothing out, so the entry is read.
    return true;
  }
}

/**
 * A value built at deploy time does not match the gate, so the resource
 * is skipped instead of being read as something it may not be.
 */
function entryApplies(
  pattern: TerraformResourcePattern,
  body: Record<string, unknown>,
): boolean {
  const gate = pattern.appliesWhen;
  if (gate === undefined) {
    return true;
  }
  const value = body[gate.attribute];
  if (value === undefined) {
    return gate.whenUnset === "read";
  }
  const text = stringOf(value);
  return text !== null && (gate.equals ?? []).includes(text);
}

/** Where in the configuration one resource was written. */
interface ResourceSite {
  label: string;
  body: Record<string, unknown>;
  sourceFile: string;
  resourceType: string;
  /** The scope a reference in this resource resolves against. */
  scope: ReferenceScope;
  options: TerraformReadOptions;
}

/** One reader for each kind of resource a pack entry can describe. */
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
  deployable: (site, boundary) => deployableSummaries({ ...site, boundary }),
};

function summariesFor(
  opts: ResourceSite & { pattern: TerraformResourcePattern },
): BehavioralSummary[] {
  const { pattern, ...site } = opts;
  // The table is typed per kind and the lookup is not, so one cast joins
  // them, as `dispatchByType` does for the IR's own unions.
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
  const address = `${opts.scope.namePrefix}${opts.resourceType}.${label}`;
  const storageSystem = storageSystemOf(opts.body, boundary, opts.scope);
  // A resource that only declares the store gets no container name and
  // no physical name. Either one would claim any access that uses the
  // same text, and the resource declares no container.
  const declaresContainer = boundary.declares !== "store";
  const physicalTable =
    !declaresContainer || boundary.nameAttribute === undefined
      ? null
      : namePattern(opts.body[boundary.nameAttribute], opts.scope);
  const listedFields = jsonFields(opts.body, boundary);

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
        storageSystem,
        ...(boundary.transport !== undefined
          ? { transport: boundary.transport }
          : {}),
        scope: containerScope(opts.body, boundary, opts.scope),
        container: declaresContainer ? label : null,
        accessPath: shape.accessPath,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: unknownEngineGaps(storageSystem, boundary),
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: declaredFieldSet(boundary, shape, listedFields),
        ...contractFields(boundary, shape, types, listedFields),
        ...(physicalTable !== null ? { physicalTable } : {}),
      },
    },
  };
}

/**
 * Null when the engine comes from an attribute the configuration does
 * not resolve. The resource is deployed and has a name, so it is still
 * read, and the gap below records that the engine is missing.
 */
function storageSystemOf(
  body: Record<string, unknown>,
  boundary: StorageResource,
  scope: ReferenceScope,
): string | null {
  const spec = boundary.storageSystem;
  if (typeof spec === "string") {
    return spec;
  }
  return meaningOf(body, spec, scope) ?? null;
}

/**
 * A store with no engine and no explanation would look like a bug in
 * the pack, so a gap on the summary explains the missing engine.
 */
function unknownEngineGaps(
  storageSystem: string | null,
  boundary: StorageResource,
): Gap[] {
  const spec = boundary.storageSystem;
  if (storageSystem !== null || typeof spec === "string") {
    return [];
  }
  return [
    {
      type: "unreadOutcome",
      conditions: [],
      consequence: "unknown",
      description: `"${spec.attribute}" states an engine this run could not settle, so which store this is stays unknown and it pairs with an access on any engine.`,
    },
  ];
}

/** The fields a store declares, from its key blocks or from its JSON schema. */
function contractFields(
  boundary: StorageResource,
  shape: KeyedShape,
  types: Map<string, string>,
  listedFields: StorageContractMetadata["fields"] | null,
): Pick<StorageContractMetadata, "identifies" | "fields"> {
  if (boundary.identifies !== undefined) {
    return {
      identifies: { kind: "keyFields", fields: shape.keyFields },
      fields: (shape.serves ?? shape.keyFields).map((field) => ({
        name: field,
        ...(types.has(field) ? { type: types.get(field) } : {}),
        ...(shape.keyFields.includes(field) ? { primary: true } : {}),
      })),
    };
  }
  return listedFields === null ? {} : { fields: listedFields };
}

/** Whether what the summary declares is every field an item has. */
function declaredFieldSet(
  boundary: StorageResource,
  shape: KeyedShape,
  listedFields: StorageContractMetadata["fields"] | null,
): StorageResource["fieldSet"] {
  // An access path that copies part of an item lists every field it will
  // ever have, whatever the container itself stores.
  if (shape.serves !== null) {
    return "exhaustive";
  }
  return listedFields === null ? boundary.fieldSet : "exhaustive";
}

/**
 * Null when the resource writes no fields as JSON. A schema a file or a
 * variable supplies is not in the configuration, so nothing is recorded.
 */
function jsonFields(
  body: Record<string, unknown>,
  boundary: StorageResource,
): StorageContractMetadata["fields"] | null {
  const spec = boundary.fieldsFromJson;
  if (spec === undefined) {
    return null;
  }
  const stated = jsonAttributeValue(valueAt(body, spec.attribute));
  if (!Array.isArray(stated)) {
    return null;
  }
  const fields = stated.flatMap((entry) => {
    const field = asRecord(entry);
    const name = field === null ? null : stringOf(field[spec.nameKey]);
    if (field === null || name === null) {
      return [];
    }
    const type =
      spec.typeKey === undefined ? null : stringOf(field[spec.typeKey]);
    return [
      {
        name,
        ...(type !== null ? { type } : {}),
        ...(spec.requires === undefined
          ? {}
          : { nullable: !alwaysSet(field, spec.requires) }),
      },
    ];
  });
  return fields.length === 0 ? null : fields;
}

/** Whether a field entry marks the field as always set. */
function alwaysSet(
  field: Record<string, unknown>,
  requires: { key: string; values: string[] },
): boolean {
  const stated = stringOf(field[requires.key]);
  return stated !== null && requires.values.includes(stated);
}

/**
 * The namespace the container belongs to, or `"default"` when the entry
 * gives no scope attribute or the resource leaves it unset.
 */
function containerScope(
  body: Record<string, unknown>,
  boundary: StorageResource,
  scope: ReferenceScope,
): string {
  if (boundary.scopeAttribute === undefined) {
    return "default";
  }
  return (
    namePattern(valueAt(body, boundary.scopeAttribute), scope) ?? "default"
  );
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
      name: `${opts.scope.namePrefix}${opts.resourceType}.${label}`,
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

/** Where a metric type template leaves room for an attribute's value. */
const TEMPLATE_HOLE = /\{([^{}]+)\}/g;

/**
 * Null when the resource leaves any of the template's attributes unset,
 * because half an identity pairs with the wrong metric as readily as
 * with the right one.
 */
function metricTypeFrom(
  template: string,
  body: Record<string, unknown>,
  scope: ReferenceScope,
): string | null {
  let missing = false;
  const spelled = template.replace(TEMPLATE_HOLE, (_whole, path: string) => {
    const stated = namePattern(valueAt(body, path), scope);
    if (stated === null) {
      missing = true;
      return "";
    }
    return stated;
  });
  return missing ? null : spelled;
}

function metricSummary(
  opts: ResourceSite & { boundary: MetricResource },
): BehavioralSummary {
  const { boundary } = opts;
  const metricType = metricTypeFrom(
    boundary.metricTypeTemplate,
    opts.body,
    opts.scope,
  );
  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: `${opts.scope.namePrefix}${opts.resourceType}.${opts.label}`,
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
    metadata: {
      metricContract: metricContract(opts.body, boundary, opts.scope),
    },
  };
}

/** The resource's measurement type and accumulation, in suss's terms. */
function metricContract(
  body: Record<string, unknown>,
  boundary: MetricResource,
  scope: ReferenceScope,
): MetricContractMetadata {
  const values = meaningOf(body, boundary.values, scope);
  const accumulates = meaningOf(body, boundary.accumulates, scope);
  return {
    ...(values !== undefined ? { values } : {}),
    ...(accumulates !== undefined ? { accumulates } : {}),
  };
}

/**
 * A reading whose metric cannot be read still becomes a summary with no
 * metric type. A resource watching an unknown metric is worth seeing,
 * even though it does not pair with anything.
 */
function readingSummaries(
  opts: ResourceSite & { boundary: MetricReadingResource },
): BehavioralSummary[] {
  const { boundary } = opts;
  const summaries: BehavioralSummary[] = [];
  for (const reading of blocksAt(
    opts.body,
    boundary.readingBlocks,
    opts.scope,
  )) {
    for (const metricType of metricsRead(
      reading,
      boundary.identifies,
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
          name: `${opts.scope.namePrefix}${opts.resourceType}.${opts.label}#${summaries.length}`,
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
        metadata: {
          metricReading: metricReading(reading, boundary, opts.scope),
        },
      });
    }
  }
  return summaries;
}

/** One reader for each way a reading can identify its metric. */
const READING_IDENTITIES: {
  [K in MetricIdentity["from"]]: (
    reading: Record<string, unknown>,
    identity: Extract<MetricIdentity, { from: K }>,
    scope: ReferenceScope,
  ) => Array<string | null>;
} = {
  attributes: (reading, identity, scope) => [
    metricTypeFrom(identity.template, reading, scope),
  ],
  query: (reading, identity, scope) =>
    metricTypesIn(
      stringOf(valueAt(reading, identity.attribute)),
      identity.key,
      scope,
    ),
};

/**
 * Every metric one reading is about, or a single null when none can be
 * read, so the reading still gets a summary.
 */
function metricsRead(
  reading: Record<string, unknown>,
  identity: MetricIdentity,
  scope: ReferenceScope,
): Array<string | null> {
  // The same single cast as in `summariesFor`: the table is typed per
  // kind and the lookup is not.
  const read = READING_IDENTITIES[identity.from] as (
    reading: Record<string, unknown>,
    identity: MetricIdentity,
    scope: ReferenceScope,
  ) => Array<string | null>;
  return read(reading, identity, scope);
}

/**
 * Every metric a query selects, or a single null when the query is
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
 * What one reading needs from the series, in suss's terms. The pack's
 * table passes through unchanged, so a finding can name the setting and
 * values that would fix it without knowing the provider's vocabulary.
 */
function metricReading(
  reading: Record<string, unknown>,
  boundary: MetricReadingResource,
  scope: ReferenceScope,
): MetricReadingMetadata {
  const compares = boundary.comparesTo;
  const comparesTo =
    compares !== undefined && valueAt(reading, compares.attribute) !== undefined
      ? compares.whenSet
      : undefined;
  const reduces = boundary.reducesTo;
  const reducesTo = meaningOf(reading, reduces, scope);
  return {
    ...(comparesTo !== undefined ? { comparesTo } : {}),
    ...(reducesTo !== undefined ? { reducesTo } : {}),
    ...(reduces === undefined
      ? {}
      : { reduction: { setting: reduces.attribute, leaves: reduces.means } }),
  };
}

/** One process a resource deploys, and what it is called inside it. */
interface DeployedProcess {
  body: Record<string, unknown>;
  /** The container's own name, or null when the resource is one process. */
  containerName: string | null;
}

/** The environment a deployment gives one process, in the form the checker reads. */
interface DeclaredEnv {
  names: string[];
  values: Record<string, string>;
  targets: Record<string, { kind: "ref"; logicalId: string }>;
}

/**
 * One summary per process a resource deploys. A function is one; a task
 * definition or a service with a sidecar is one per container, since
 * each container starts with an environment of its own.
 */
function deployableSummaries(
  opts: ResourceSite & { boundary: DeployableResource },
): BehavioralSummary[] {
  const { boundary, label } = opts;
  return deployedProcesses(opts.body, boundary, opts.scope).map((process) =>
    deployableSummary({
      ...opts,
      boundary,
      process,
      instanceName:
        process.containerName === null
          ? label
          : ecsContainerInstanceName(label, process.containerName),
    }),
  );
}

function deployableSummary(
  opts: ResourceSite & {
    boundary: DeployableResource;
    process: DeployedProcess;
    instanceName: string;
  },
): BehavioralSummary {
  const { boundary, instanceName, process } = opts;
  const declared = declaredEnv(process.body, boundary.env ?? [], opts.scope);
  const platform =
    boundary.platformEnvVars ??
    PLATFORM_INJECTED_ENV_VARS[boundary.deploymentTarget];
  const code = codePointer(process.body, boundary, opts.scope);
  const image = attributePattern(
    process.body,
    boundary.code?.imageAttribute,
    opts.scope,
  );
  const runtime = attributePattern(
    process.body,
    boundary.runtimeAttribute,
    opts.scope,
  );
  const prefix = opts.scope.namePrefix;
  const deployableUnit: DeployableUnit = {
    deploymentTarget: boundary.deploymentTarget,
    instanceName: `${prefix}${instanceName}`,
  };

  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: `${prefix}${opts.resourceType}.${instanceName.replace("/", "#")}`,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "terraform",
        ...deployableUnit,
      }),
      deployableUnit,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withRuntimeContractMetadata(
      {
        codeScope: declaredCodeScope(
          opts.options.codeScopes?.[deployableUnit.instanceName],
          code.entry,
        ),
      },
      {
        envVars: [...new Set([...declared.names, ...platform])].sort(),
        envVarSources: envVarSources(declared.names, platform),
        ...(Object.keys(declared.targets).length > 0
          ? { envVarTargets: declared.targets }
          : {}),
        ...(Object.keys(declared.values).length > 0
          ? { envVarValues: declared.values }
          : {}),
        ...(code.entryPoint !== null ? { entryPoint: code.entryPoint } : {}),
        ...(image !== null ? { image } : {}),
        ...(runtime !== null ? { runtime } : {}),
      },
    ),
  };
}

/**
 * A configuration gives the handler that runs but never the directory
 * the artifact was built from, so the entry is all the checker gets
 * until the caller supplies a directory.
 */
function declaredCodeScope(
  directory: string | undefined,
  entry: string | null,
): CodeScopeMetadata {
  const written = entry !== null ? { entry } : {};
  if (directory !== undefined) {
    return { kind: "codeUri", path: directory, ...written };
  }
  return { kind: "unknown", ...written };
}

/** Where each variable came from: the configuration, or the platform. */
function envVarSources(
  declared: string[],
  platform: readonly string[],
): Record<string, EnvVarSource> {
  const sources: Record<string, EnvVarSource> = {};
  for (const name of declared) {
    sources[name] = "template";
  }
  for (const name of platform) {
    sources[name] ??= "platform";
  }
  return sources;
}

/** Each process the resource deploys, or the resource itself when it is one. */
function deployedProcesses(
  body: Record<string, unknown>,
  boundary: DeployableResource,
  scope: ReferenceScope,
): DeployedProcess[] {
  const containers = boundary.containers;
  if (containers === undefined) {
    return [{ body, containerName: null }];
  }
  return blocksAt(body, containers.blocks, scope).map((container) => ({
    body: container,
    containerName:
      containers.nameAttribute === undefined
        ? null
        : stringOf(container[containers.nameAttribute]),
  }));
}

/** Which code the platform calls, as the configuration writes it. */
interface CodePointer {
  /** The handler string as written, or null when the resource has none. */
  entryPoint: string | null;
  /** The file the handler is in, when the spelling includes one. */
  entry: string | null;
}

/**
 * Gets the module from each handler spelling. A bare exported name has
 * no file, so the unit is placed by whatever else the run has found.
 */
const HANDLER_MODULE: Record<
  HandlerSpelling,
  (written: string) => string | null
> = {
  "module.export": (written) => parseHandler(written)?.modulePath ?? null,
  name: () => null,
};

function codePointer(
  body: Record<string, unknown>,
  boundary: DeployableResource,
  scope: ReferenceScope,
): CodePointer {
  const spec = boundary.code?.handler;
  const written = attributePattern(body, spec?.attribute, scope);
  if (spec === undefined || written === null) {
    return { entryPoint: null, entry: null };
  }
  // Splitting a handler with a hole in it at its last dot picks a file
  // nobody deploys, so the unit is placed by whatever else the run has found.
  return {
    entryPoint: written,
    entry: hasNameHole(written) ? null : HANDLER_MODULE[spec.spelling](written),
  };
}

/** One reader per way a provider writes an environment. */
type EnvReaders = {
  [K in EnvDeclaration["style"]]: (
    body: Record<string, unknown>,
    declaration: Extract<EnvDeclaration, { style: K }>,
    into: DeclaredEnv,
    scope: ReferenceScope,
  ) => void;
};

const ENV_READERS: EnvReaders = {
  map: (body, declaration, into, scope) => {
    const stated = asRecord(valueAt(body, declaration.attribute)) ?? {};
    for (const [name, value] of Object.entries(stated)) {
      setVariable(into, name, stringOf(value), scope);
    }
  },
  entries: (body, declaration, into, scope) => {
    for (const entry of blocksAt(body, declaration.block.split("."), scope)) {
      const name = stringOf(entry[declaration.nameAttribute]);
      if (name === null) {
        continue;
      }
      setVariable(
        into,
        name,
        attributeText(entry, declaration.valueAttribute),
        scope,
      );
      setTarget(
        into,
        name,
        attributeText(entry, declaration.secretAttribute),
        scope,
      );
    }
  },
};

function declaredEnv(
  body: Record<string, unknown>,
  declarations: EnvDeclaration[],
  scope: ReferenceScope,
): DeclaredEnv {
  const declared: DeclaredEnv = { names: [], values: {}, targets: {} };
  for (const declaration of declarations) {
    // The same single cast as in `summariesFor`: the table is typed per
    // style and the lookup is not.
    const read = ENV_READERS[declaration.style] as (
      body: Record<string, unknown>,
      declaration: EnvDeclaration,
      into: DeclaredEnv,
      scope: ReferenceScope,
    ) => void;
    read(body, declaration, declared, scope);
  }
  return declared;
}

/**
 * A value that is a single reference gives both the resource's literal
 * value and the resource itself, so both are recorded.
 */
function setVariable(
  into: DeclaredEnv,
  name: string,
  written: string | null,
  scope: ReferenceScope,
): void {
  if (!into.names.includes(name)) {
    into.names.push(name);
  }
  if (written === null) {
    return;
  }
  const pattern = namePattern(written, scope);
  if (pattern !== null) {
    into.values[name] = pattern;
  }
  setTarget(into, name, written, scope);
}

/**
 * A secret goes only through here. The process reads the secret's
 * contents, which no configuration contains, so only the resource is
 * recorded.
 */
function setTarget(
  into: DeclaredEnv,
  name: string,
  written: string | null,
  scope: ReferenceScope,
): void {
  const target = written === null ? null : referencedResource(written, scope);
  if (target !== null) {
    into.targets[name] = { kind: "ref", logicalId: target };
  }
}

/** The attribute's value as text, or null when the entry has none. */
function attributeText(
  body: Record<string, unknown>,
  attribute: string | undefined,
): string | null {
  return attribute === undefined ? null : stringOf(valueAt(body, attribute));
}

/**
 * The attribute's value as a name pattern, so an image or handler that a
 * variable supplies is written like every other unresolved value.
 */
function attributePattern(
  body: Record<string, unknown>,
  attribute: string | undefined,
  scope: ReferenceScope,
): string | null {
  return attribute === undefined
    ? null
    : namePattern(valueAt(body, attribute), scope);
}

/** How a value selects an entry in the `means` table, for each `matches` mode. */
const MEANING_KEYS: Record<
  NonNullable<AttributeMeaning<string>["matches"]>,
  (stated: string, keys: string[]) => string | undefined
> = {
  value: (stated, keys) => keys.find((key) => key === stated),
  prefix: (stated, keys) => keys.find((key) => stated.startsWith(key)),
};

/**
 * The pack's meaning for the value at the attribute. An unset attribute
 * gets `whenUnset`. A value built at deploy time, or one the pack does
 * not list, gets undefined.
 */
function meaningOf<T extends string>(
  body: Record<string, unknown>,
  spec: AttributeMeaning<T> | undefined,
  scope: ReferenceScope,
): T | undefined {
  if (spec === undefined) {
    return undefined;
  }
  const value = valueAt(body, spec.attribute);
  if (value === undefined) {
    return spec.whenUnset;
  }
  const written = stringOf(value);
  const stated = written === null ? null : resolveReferences(written, scope);
  if (stated === null || stated.includes("${")) {
    return undefined;
  }
  const key = MEANING_KEYS[spec.matches ?? "value"](
    stated,
    Object.keys(spec.means),
  );
  return key === undefined ? undefined : spec.means[key];
}

/**
 * The value at a dotted path, stepping into blocks on the way. A path
 * points at one value, so a repeated block contributes only its first
 * instance.
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

/**
 * Every block at the end of a chain of nested block names, including
 * blocks that a `dynamic` block expands to.
 */
function blocksAt(
  body: Record<string, unknown>,
  blocks: string[],
  scope: ReferenceScope,
): Array<Record<string, unknown>> {
  let found: Array<Record<string, unknown>> = [body];
  for (const block of blocks) {
    found = found.flatMap((record) => [
      ...nestedRecords(record[block], scope),
      ...dynamicBlocks(record, block, scope),
    ]);
  }
  return found;
}

/**
 * ECS container definitions and similar structures can arrive as plain
 * blocks, a JSON string or a `for` expression, and each form comes back
 * as the same records.
 */
function nestedRecords(
  value: unknown,
  scope: ReferenceScope,
): Array<Record<string, unknown>> {
  const iterated = iteratedRecords(value, scope);
  if (iterated !== null) {
    return iterated;
  }
  const stated = typeof value === "string" ? jsonAttributeValue(value) : value;
  return arrayOf(stated)
    .map(asRecord)
    .filter((nested): nested is Record<string, unknown> => nested !== null);
}

/**
 * The resource's own key, then one shape per access path block. An
 * entry with no `identifies` gives one shape with no key fields, as a
 * bucket has.
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
 * Null when the access path returns the whole item. A store always
 * returns the index keys and the table keys, so those count however
 * narrow the copy is.
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
 * The key fields a block lists, in the order the entry gives. DynamoDB
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

function localsIn(
  document: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const block of arrayOf(document.locals)) {
    const stated = asRecord(block);
    if (stated !== null) {
      found.push(stated);
    }
  }
  return found;
}

/** Every resource in a document, as `[type, label, body]`. */
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
 * A reference to a resource in this configuration resolves to that
 * resource's value first, so it does not become a hole in the pattern.
 */
function namePattern(value: unknown, scope: ReferenceScope): string | null {
  return namePatternFromSub(
    typeof value === "string" ? resolveReferences(value, scope) : value,
  );
}
