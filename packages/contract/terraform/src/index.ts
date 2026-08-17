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
 * that builds the same name from its own variable. The README says how
 * a block that HCL states once or many times is read.
 */

import fs from "node:fs";
import path from "node:path";

// The parser ships CommonJS, so ESM reaches it through the default.
import hcl2 from "hcl2-parser";
import semver from "semver";

import {
  messageBusBinding,
  namePatternFromSub,
  storageBinding,
} from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  MessageBusResource,
  StorageResource,
  TerraformPack,
  TerraformResourcePattern,
} from "./pack.js";

export type {
  MessageBusResource,
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
}

/** Every boundary one Terraform configuration declares. */
export function terraformToSummaries(
  source: string,
  sourceFile: string,
  options: TerraformReadOptions,
): BehavioralSummary[] {
  let parsed: unknown;
  try {
    // The parser gives back what it read and what stopped it, and a
    // file it could not read comes back as nothing.
    const [read] = hcl2.parseToObject(source);
    parsed = read;
  } catch {
    return [];
  }
  const document = asRecord(parsed);
  if (document === null) {
    return [];
  }

  const constraints = providerConstraints(document);
  const summaries: BehavioralSummary[] = [];
  for (const [resourceType, label, body] of resourcesIn(document)) {
    for (const pack of options.packs) {
      const pattern = patternFor(pack, resourceType, constraints);
      if (pattern === undefined) {
        continue;
      }
      summaries.push(
        ...summariesFor({ pattern, label, body, sourceFile, resourceType }),
      );
    }
  }
  return summaries;
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
  return files.flatMap((file) =>
    terraformToSummaries(fs.readFileSync(file, "utf8"), file, options),
  );
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

function summariesFor(opts: {
  pattern: TerraformResourcePattern;
  label: string;
  body: Record<string, unknown>;
  sourceFile: string;
  resourceType: string;
}): BehavioralSummary[] {
  const { pattern } = opts;
  if (pattern.boundary.kind === "message-bus") {
    return [busSummary({ ...opts, boundary: pattern.boundary })];
  }
  const boundary = pattern.boundary;
  const types = fieldTypes(opts.body, boundary);
  return keyedShapes(opts.body, boundary).map((shape) =>
    storageSummary({ ...opts, boundary, shape, types }),
  );
}

function storageSummary(opts: {
  boundary: StorageResource;
  label: string;
  body: Record<string, unknown>;
  shape: KeyedShape;
  types: Map<string, string>;
  sourceFile: string;
  resourceType: string;
}): BehavioralSummary {
  const { boundary, label, shape, types } = opts;
  // Two resource types may share a label, so the summary goes by the
  // address Terraform itself refers to a resource by.
  const address = `${opts.resourceType}.${label}`;
  const declaredName =
    boundary.nameAttribute === undefined
      ? null
      : stringOf(opts.body[boundary.nameAttribute]);
  const physicalTable =
    declaredName === null ? null : namePatternFromSub(declaredName);

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
        fieldSet: boundary.fieldSet,
        ...(boundary.identifies === undefined
          ? {}
          : {
              identifies: { kind: "keyFields", fields: shape.keyFields },
              fields: shape.keyFields.map((field) => ({
                name: field,
                ...(types.has(field) ? { type: types.get(field) } : {}),
                primary: true,
              })),
            }),
        ...(physicalTable !== null ? { physicalTable } : {}),
      },
    },
  };
}

function busSummary(opts: {
  boundary: MessageBusResource;
  label: string;
  body: Record<string, unknown>;
  sourceFile: string;
  resourceType: string;
}): BehavioralSummary {
  const { boundary, label } = opts;
  const declaredName =
    boundary.nameAttribute === undefined
      ? null
      : stringOf(opts.body[boundary.nameAttribute]);
  const physicalName =
    declaredName === null ? null : namePatternFromSub(declaredName);

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
    return [{ accessPath: null, keyFields: [] }];
  }
  const shapes: KeyedShape[] = [
    { accessPath: null, keyFields: keyFields(body, boundary.identifies) },
  ];
  for (const block of boundary.accessPathBlocks ?? []) {
    for (const declared of arrayOf(body[block])) {
      const index = asRecord(declared);
      const indexName = index === null ? null : stringOf(index.name);
      if (index === null || indexName === null) {
        continue;
      }
      shapes.push({
        accessPath: indexName,
        keyFields: keyFields(index, boundary.identifies),
      });
    }
  }
  return shapes;
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
