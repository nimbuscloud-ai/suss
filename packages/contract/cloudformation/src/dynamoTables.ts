// dynamoTables.ts: a DynamoDB table as a storage boundary.
//
// The template already reaches a function's runtime config when a Ref
// wires a table name into an env var, but nothing recorded the table
// itself, so a writer in one service and a reader in another had
// nothing to pair on (#143).
//
// The key schema is what the table declares, and it is not the whole
// item. A caller writes any attributes it likes beside the keys, so
// these go under their own namespace rather than storageContract,
// whose columns mean the complete set and would report every
// non-key attribute as unknown.

import { storageTableBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CloudFormationResource } from "./index.js";

interface KeyField {
  name: string;
  keyType: string;
  type: string | null;
}

export function buildDynamoTableSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::DynamoDB::Table") {
      continue;
    }
    summaries.push(
      tableSummary(logicalId, resource.Properties ?? {}, sourceFile),
    );
  }
  return summaries;
}

function tableSummary(
  logicalId: string,
  props: Record<string, unknown>,
  sourceFile: string,
): BehavioralSummary {
  // A template that states no TableName lets CloudFormation generate
  // one, and the logical id is what the rest of the template refers to.
  const declared = props.TableName;
  const table = typeof declared === "string" ? declared : logicalId;
  const keys = keyFields(props);

  return {
    kind: "library",
    location: {
      file: `${sourceFile}:${logicalId}`,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: table,
      exportPath: null,
      boundaryBinding: storageTableBinding({
        recognition: "cloudformation",
        storageSystem: "dynamodb",
        table,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageTableContract: {
        keys: keys.map((key) => ({
          name: key.name,
          keyType: key.keyType,
          ...(key.type !== null ? { type: key.type } : {}),
        })),
      },
    },
  };
}

/** The partition and sort keys, with the type each attribute definition gives. */
function keyFields(props: Record<string, unknown>): KeyField[] {
  const schema = props.KeySchema;
  if (!Array.isArray(schema)) {
    return [];
  }
  const types = attributeTypes(props.AttributeDefinitions);
  const fields: KeyField[] = [];
  for (const entry of schema) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as { AttributeName?: unknown }).AttributeName;
    const keyType = (entry as { KeyType?: unknown }).KeyType;
    if (typeof name !== "string") {
      continue;
    }
    fields.push({
      name,
      keyType: typeof keyType === "string" ? keyType : "HASH",
      type: types.get(name) ?? null,
    });
  }
  return fields;
}

function attributeTypes(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
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
