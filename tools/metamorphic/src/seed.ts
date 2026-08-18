import { dynamoFramework } from "@suss/framework-aws-dynamodb";
import { redisFramework } from "@suss/framework-redis";

import type { PatternPack } from "@suss/extractor";

/**
 * The smallest program whose effects are known: one discovered unit, one
 * recognized boundary call, one effect.
 *
 * A seed says what the call needs rather than writing the program out,
 * because a rewrite is what decides where the client is made and where
 * the call goes. The README says how to add a third one.
 */
export interface Seed {
  /** What a failure prints alongside the rewrite. */
  readonly name: string;
  /** Type declarations the client library ships, by path. */
  readonly library: Readonly<Record<string, string>>;
  /** The import every module performing the call needs. */
  readonly importLine: string;
  /** The type a client is annotated with. */
  readonly clientType: string;
  /** An expression that makes a client. */
  readonly newClient: string;
  /** The boundary call, given an expression for the client and for the id. */
  readonly access: (client: string, id: string) => string;
  /** The pack that recognizes the call. */
  readonly pack: () => PatternPack;
}

function packageFiles(
  name: string,
  types: string,
  declarations: string,
): Readonly<Record<string, string>> {
  return {
    [`/node_modules/${name}/package.json`]: JSON.stringify({ name, types }),
    [`/node_modules/${name}/${types}`]: declarations,
  };
}

const dynamodb: Seed = {
  name: "dynamodb",
  library: packageFiles(
    "@aws-sdk/lib-dynamodb",
    "index.d.ts",
    `
      export declare class DynamoDBDocumentClient {
        send(command: unknown): Promise<unknown>;
      }
      export declare class GetCommand { constructor(input: unknown); }
    `,
  ),
  importLine: `import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";`,
  clientType: "DynamoDBDocumentClient",
  newClient: "new DynamoDBDocumentClient()",
  access: (client, id) =>
    `${client}.send(new GetCommand({ TableName: "orders-v1", Key: { orderId: ${id} } }))`,
  pack: dynamoFramework,
};

const redis: Seed = {
  name: "redis",
  library: packageFiles(
    "ioredis",
    "built/index.d.ts",
    `
      export default class Redis {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<string>;
      }
    `,
  ),
  importLine: `import Redis from "ioredis";`,
  clientType: "Redis",
  newClient: "new Redis()",
  access: (client, id) => `${client}.get("session:" + ${id})`,
  pack: redisFramework,
};

export const SEEDS: readonly Seed[] = [dynamodb, redis];
