import { describe, expect, it } from "vitest";

import { interactionsOf, packUnderTest } from "@suss/pack-harness";

import { ssmFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

// The recognizer walks an import back to the module that declared it,
// so every module a fixture imports has to be on disk.
const SSM_TYPES = `
export class SSMClient {
  constructor(config?: unknown);
  send(command: unknown): Promise<unknown>;
}
export class GetParameterCommand {
  constructor(input: { Name?: string; WithDecryption?: boolean });
}
export class GetParametersCommand {
  constructor(input: { Names?: string[]; WithDecryption?: boolean });
}
export class PutParameterCommand {
  constructor(input: { Name?: string; Value?: string; Type?: string });
}
`;

const LIBRARY = { "@aws-sdk/client-ssm": SSM_TYPES };

const accessesIn = (source: string) =>
  interactionsOf(
    packUnderTest(ssmFramework(), { library: LIBRARY }).effectsIn(source),
    "storage-access",
  );

const containerOf = (effect: Effect | undefined): string | null => {
  if (effect?.type !== "interaction") {
    return raise("not an interaction");
  }
  const semantics = effect.binding.semantics;
  return semantics.name === "storage" ? semantics.container : null;
};

describe("ssm parameter store", () => {
  it("records a read against the parameter the call named", () => {
    const accesses = accessesIn(`
      import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
      const ssm = new SSMClient({});
      async function host() {
        return ssm.send(new GetParameterCommand({ Name: "/prod/db/host" }));
      }
    `);
    expect(accesses).toHaveLength(1);
    const access = accesses[0] ?? raise("no access");
    expect(access.binding.semantics).toMatchObject({
      name: "storage",
      storageSystem: "aws.ssm",
      scope: "default",
      container: "/prod/db/host",
    });
    expect(access.interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "GetParameterCommand",
    });
  });

  it("gives one access per parameter a multi-read lists", () => {
    const accesses = accessesIn(`
      import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
      const ssm = new SSMClient({});
      async function both() {
        return ssm.send(new GetParametersCommand({
          Names: ["/prod/db/host", "/prod/db/port"],
          WithDecryption: true,
        }));
      }
    `);
    expect(accesses.map(containerOf)).toEqual([
      "/prod/db/host",
      "/prod/db/port",
    ]);
  });

  it("records one unnamed read when it cannot read the list of names", () => {
    const accesses = accessesIn(`
      import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
      const ssm = new SSMClient({});
      async function some(names: string[]) {
        return ssm.send(new GetParametersCommand({ Names: names }));
      }
    `);
    expect(accesses).toHaveLength(1);
    expect(containerOf(accesses[0])).toBeNull();
  });

  it("records a write for a put", () => {
    const access =
      accessesIn(`
      import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
      const ssm = new SSMClient({});
      async function set() {
        return ssm.send(new PutParameterCommand({ Name: "/prod/db/host", Value: "db", Type: "String" }));
      }
    `)[0] ?? raise("no access");
    expect(access.interaction).toMatchObject({ kind: "write" });
    expect(containerOf(access)).toBe("/prod/db/host");
  });

  it("keeps the env var name when the parameter is only named at deploy time", () => {
    const access =
      accessesIn(`
      import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
      const ssm = new SSMClient({});
      async function host() {
        return ssm.send(new GetParameterCommand({ Name: process.env.DB_HOST_PARAM }));
      }
    `)[0] ?? raise("no access");
    expect(containerOf(access)).toBe("{DB_HOST_PARAM}");
  });
});
