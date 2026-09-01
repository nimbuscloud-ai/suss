import { describe, expect, it } from "vitest";

import { interactionsOf, packUnderTest } from "@suss/pack-harness";

import { secretsManagerFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

// The recognizer walks an import back to the module that declared it,
// so every module a fixture imports has to be on disk.
const SECRETS_TYPES = `
export class SecretsManagerClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class GetSecretValueCommand {
  constructor(input: { SecretId?: string });
}
export class BatchGetSecretValueCommand {
  constructor(input: { SecretIdList?: string[] });
}
export class PutSecretValueCommand {
  constructor(input: { SecretId?: string; SecretString?: string });
}
export class CreateSecretCommand {
  constructor(input: { Name?: string; SecretString?: string });
}
`;

const LIBRARY = { "@aws-sdk/client-secrets-manager": SECRETS_TYPES };

const accessesIn = (source: string) =>
  interactionsOf(
    packUnderTest(secretsManagerFramework(), { library: LIBRARY }).effectsIn(
      source,
    ),
    "storage-access",
  );

const containerOf = (effect: Effect | undefined): string | null => {
  if (effect?.type !== "interaction") {
    return raise("not an interaction");
  }
  const semantics = effect.binding.semantics;
  return semantics.name === "storage" ? semantics.container : null;
};

describe("secrets manager", () => {
  it("records a read against the secret the call named", () => {
    const accesses = accessesIn(`
      import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
      const secrets = new SecretsManagerClient({});
      async function password() {
        return secrets.send(new GetSecretValueCommand({ SecretId: "prod/db/password" }));
      }
    `);
    expect(accesses).toHaveLength(1);
    const access = accesses[0] ?? raise("no access");
    expect(access.binding.semantics).toMatchObject({
      name: "storage",
      storageSystem: "aws.secretsmanager",
      scope: "default",
      container: "prod/db/password",
    });
    expect(access.interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "GetSecretValueCommand",
    });
  });

  it("keeps the env var name when the secret is only named at deploy time", () => {
    const access =
      accessesIn(`
      import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
      const secrets = new SecretsManagerClient({});
      async function password() {
        return secrets.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ID }));
      }
    `)[0] ?? raise("no access");
    expect(containerOf(access)).toBe("{DB_SECRET_ID}");
  });

  it("records a write for a put, and takes a create's Name as the secret", () => {
    const accesses = accessesIn(`
      import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
      const secrets = new SecretsManagerClient({});
      async function rotate() {
        await secrets.send(new CreateSecretCommand({ Name: "prod/api/key", SecretString: "{}" }));
        await secrets.send(new PutSecretValueCommand({ SecretId: "prod/api/key", SecretString: "{}" }));
      }
    `);
    expect(accesses.map(containerOf)).toEqual(["prod/api/key", "prod/api/key"]);
    expect(accesses.map((a) => a.interaction.kind)).toEqual(["write", "write"]);
  });

  it("gives one access per secret a batch read lists", () => {
    const accesses = accessesIn(`
      import { SecretsManagerClient, BatchGetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
      const secrets = new SecretsManagerClient({});
      async function both() {
        return secrets.send(new BatchGetSecretValueCommand({
          SecretIdList: ["prod/db/password", "prod/api/key"],
        }));
      }
    `);
    expect(accesses.map(containerOf)).toEqual([
      "prod/db/password",
      "prod/api/key",
    ]);
  });

  it("leaves a command class from somewhere else alone", () => {
    const accesses = accessesIn(`
      import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
      class GetSecretValueCommand {
        constructor(_input: unknown) {}
      }
      const secrets = new SecretsManagerClient({});
      async function password() {
        return secrets.send(new GetSecretValueCommand({ SecretId: "prod/db/password" }));
      }
    `);
    expect(accesses).toHaveLength(0);
  });
});
