/**
 * A DynamoDB table as a storage boundary.
 *
 * The template already reaches a function's runtime config when a Ref
 * wires a table name into an env var, but nothing recorded the table
 * itself, so a writer in one service and a reader in another had
 * nothing to pair on (#143).
 *
 * A table declares its key attributes and nothing else, so the contract
 * says `fieldSet: "partial"` and the pass leaves an ordinary attribute
 * alone. Each secondary index gets its own summary, because a query
 * through an index keys on that index's fields rather than the table's.
 */

import { namePatternFromSub, storageBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CloudFormationResource } from "@suss/manifest-aws";

/** Every attribute a table declares a type for, by name. */
type AttributeTypes = Map<string, string>;

interface KeyedShape {
  /** The index this describes, or null for the table's own key. */
  accessPath: string | null;
  keyFields: string[];
}

export function buildDynamoTableSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  recognition: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::DynamoDB::Table") {
      continue;
    }
    const props = resource.Properties ?? {};
    const types = attributeTypes(props.AttributeDefinitions);
    for (const shape of keyedShapes(props)) {
      summaries.push(
        tableSummary({
          logicalId,
          props,
          shape,
          types,
          sourceFile,
          recognition,
        }),
      );
    }
  }
  return summaries;
}

function tableSummary(opts: {
  logicalId: string;
  props: Record<string, unknown>;
  shape: KeyedShape;
  types: AttributeTypes;
  sourceFile: string;
  recognition: string;
}): BehavioralSummary {
  const { logicalId, props, shape, types } = opts;
  // The rest of the template refers to a table by its logical id, so
  // that is the container, and a stated TableName is the other name
  // code can spell. The storage pass matches an access against either.
  // A TableName built at deploy time is recorded with its parameter as
  // a hole, since code that builds the same name pairs on the rest.
  const physicalTable = readPhysicalName(props.TableName);
  const name =
    shape.accessPath === null ? logicalId : `${logicalId}#${shape.accessPath}`;

  return {
    kind: "library",
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: opts.recognition,
        storageSystem: "aws.dynamodb",
        // A caller reaches the table through the AWS SDK over HTTPS,
        // rather than through a wire protocol of its own.
        transport: "aws-sdk",
        scope: "default",
        container: logicalId,
        accessPath: shape.accessPath,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: "partial",
        identifies: { kind: "keyFields", fields: shape.keyFields },
        fields: shape.keyFields.map((field) => ({
          name: field,
          ...(types.has(field) ? { type: types.get(field) } : {}),
          primary: true,
        })),
        ...(physicalTable !== null ? { physicalTable } : {}),
      },
    },
  };
}

/**
 * A stated name, as a pattern when the template builds one. YAML's
 * `!Sub` tag resolves to the string it was written with, and the JSON
 * form arrives as an object, so both go through the same reading.
 */
function readPhysicalName(declared: unknown): string | null {
  if (typeof declared === "string") {
    return namePatternFromSub(declared);
  }
  if (typeof declared !== "object" || declared === null) {
    return null;
  }
  return namePatternFromSub((declared as { "Fn::Sub"?: unknown })["Fn::Sub"]);
}

/**
 * The table's own key, then one entry per secondary index. A local
 * index and a global one both key differently from the table, and a
 * caller states which it queries, so each is its own boundary.
 */
function keyedShapes(props: Record<string, unknown>): KeyedShape[] {
  const shapes: KeyedShape[] = [
    { accessPath: null, keyFields: keyFields(props.KeySchema) },
  ];
  for (const key of ["GlobalSecondaryIndexes", "LocalSecondaryIndexes"]) {
    const declared = props[key];
    if (!Array.isArray(declared)) {
      continue;
    }
    for (const index of declared) {
      if (typeof index !== "object" || index === null) {
        continue;
      }
      const indexName = (index as { IndexName?: unknown }).IndexName;
      if (typeof indexName !== "string") {
        continue;
      }
      shapes.push({
        accessPath: indexName,
        keyFields: keyFields((index as { KeySchema?: unknown }).KeySchema),
      });
    }
  }
  return shapes;
}

/**
 * The attributes a key schema states, partition key first. DynamoDB
 * takes them in that order, so a caller that supplies the sort key
 * without the partition key has supplied neither.
 */
function keyFields(schema: unknown): string[] {
  if (!Array.isArray(schema)) {
    return [];
  }
  const hash: string[] = [];
  const range: string[] = [];
  for (const entry of schema) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as { AttributeName?: unknown }).AttributeName;
    const keyType = (entry as { KeyType?: unknown }).KeyType;
    if (typeof name !== "string") {
      continue;
    }
    (keyType === "RANGE" ? range : hash).push(name);
  }
  return [...hash, ...range];
}

function attributeTypes(raw: unknown): AttributeTypes {
  const out: AttributeTypes = new Map();
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as { AttributeName?: unknown }).AttributeName;
    const type = (entry as { AttributeType?: unknown }).AttributeType;
    if (typeof name === "string" && typeof type === "string") {
      out.set(name, type);
    }
  }
  return out;
}
