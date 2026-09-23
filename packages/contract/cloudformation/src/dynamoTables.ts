/**
 * Summaries for DynamoDB tables as storage boundaries, so a writer in one
 * service and a reader in another have a table to pair on (#143).
 *
 * A table declares only its key attributes, so the contract has
 * `fieldSet: "partial"` and reading any other attribute is not a finding.
 * Each secondary index gets its own summary, because a query through an
 * index uses that index's key fields.
 */

import { namePatternFromSub, storageBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CloudFormationResource } from "@suss/manifest-aws";

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
  // The container is the logical id, since the rest of the template uses
  // it, and a TableName is kept as a second name code may use. A name
  // built with `!Sub` keeps its parameters as wildcards.
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
        // Callers reach DynamoDB through the AWS SDK over HTTPS.
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

// YAML's `!Sub` tag parses to its plain string and the JSON form to an
// object, so both are handled here.
function readPhysicalName(declared: unknown): string | null {
  if (typeof declared === "string") {
    return namePatternFromSub(declared);
  }
  if (typeof declared !== "object" || declared === null) {
    return null;
  }
  return namePatternFromSub((declared as { "Fn::Sub"?: unknown })["Fn::Sub"]);
}

/** The table's own key, then one entry per local or global index. */
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

// Partition key first: DynamoDB cannot use a sort key without the
// partition key.
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
