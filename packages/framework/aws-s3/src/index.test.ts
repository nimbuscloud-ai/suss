import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  callOpsFor,
  isImportedFrom,
  ResolutionStore,
} from "@suss/adapter-typescript";
import { runExamples } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { s3Framework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// The declaration settles a command by where its class came from, so a
// fixture needs the SDK on disk to resolve against.
const SDK_TYPES = `
  export declare class S3Client { send(command: unknown): Promise<unknown>; }
  export declare class GetObjectCommand { constructor(input: unknown); }
  export declare class HeadObjectCommand { constructor(input: unknown); }
  export declare class PutObjectCommand { constructor(input: unknown); }
  export declare class DeleteObjectCommand { constructor(input: unknown); }
  export declare class ListObjectsV2Command { constructor(input: unknown); }
  export declare class GetBucketPolicyCommand { constructor(input: unknown); }
`;

const PRESIGNER_TYPES = `
  export declare function getSignedUrl(
    client: unknown,
    command: unknown,
    options?: unknown,
  ): Promise<string>;
`;

function effectsIn(source: string): Effect[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/@aws-sdk/client-s3/package.json",
    JSON.stringify({ name: "@aws-sdk/client-s3", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/@aws-sdk/client-s3/index.d.ts",
    SDK_TYPES,
  );
  project.createSourceFile(
    "/node_modules/@aws-sdk/s3-request-presigner/package.json",
    JSON.stringify({
      name: "@aws-sdk/s3-request-presigner",
      types: "index.d.ts",
    }),
  );
  project.createSourceFile(
    "/node_modules/@aws-sdk/s3-request-presigner/index.d.ts",
    PRESIGNER_TYPES,
  );
  const sourceFile: SourceFile = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const recognizers = s3Framework().invocationRecognizers ?? [];
  const effects: Effect[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: () => [],
      isImportedFrom,
      resolveWrittenValue: (value: Node) => store.resolveWrittenValue(value),
      ops: callOpsFor(node, (value: Node) => store.resolveWrittenValue(value)),
    };
    for (const recognizer of recognizers) {
      const emitted = recognizer(node, ctx);
      if (emitted !== null) {
        effects.push(...emitted);
      }
    }
  });
  return effects;
}

function storageOf(effect: Effect) {
  if (effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect.type}`);
  }
  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  return { semantics, interaction: effect.interaction };
}

const IMPORTS = `import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";`;

describe("an S3 object call", () => {
  it("reads the bucket a call addresses and the key it asks for", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      export async function fetchReport(id: string) {
        return client.send(new GetObjectCommand({
          Bucket: "reports-prod",
          Key: \`reports/\${id}.pdf\`,
        }));
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "s3",
      container: "reports-prod",
      accessPath: null,
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      fields: [],
      operation: "GetObjectCommand",
      selector: ["reports/{id}.pdf"],
    });
  });

  it("reads a write as a write", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      export async function store(id: string, body: string) {
        return client.send(new PutObjectCommand({
          Bucket: "reports-prod",
          Key: \`reports/\${id}.pdf\`,
          Body: body,
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "PutObjectCommand",
    });
  });

  it("follows a bucket through the field a constructor set", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      export class ReportStore {
        private readonly bucket: string;
        constructor(stage?: string) {
          this.bucket = \`\${stage}-reports\`;
        }
        async get(id: string) {
          const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: id,
          });
          return client.send(command);
        }
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("{stage}-reports");
  });

  it("reads the prefix a listing asks for, since that is what it addressed", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      export async function listFor(tenant: string) {
        return client.send(new ListObjectsV2Command({
          Bucket: "uploads",
          Prefix: \`tenants/\${tenant}/\`,
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      selector: ["tenants/{tenant}/"],
    });
  });

  it("says which parameter a bucket it cannot settle comes from", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      export async function get(bucket: string, key: string) {
        return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("{bucket}");
  });

  it("leaves a command class of the same name from somewhere else alone", () => {
    expect(
      effectsIn(`
        import { GetObjectCommand } from "./ourOwnCommands";
        declare const client: { send(command: unknown): Promise<unknown> };
        export async function get() {
          return client.send(new GetObjectCommand({ Bucket: "b", Key: "k" }));
        }
      `),
    ).toEqual([]);
  });
});

describe("a command handed to something other than send", () => {
  it("reads a presigned URL as an access, since the URL reaches the same object", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
      declare const client: S3Client;
      export async function urlFor(key: string) {
        const command = new GetObjectCommand({ Bucket: "uploads", Key: key });
        return getSignedUrl(client, command, { expiresIn: 900 });
      }
    `);

    expect(effects).toHaveLength(1);
    expect(storageOf(effects[0]).semantics.container).toBe("uploads");
  });

  it("reads a command a nested call takes once, not once per call around it", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      declare function retry<T>(run: Promise<T>): Promise<T>;
      export async function get() {
        return retry(client.send(new GetObjectCommand({ Bucket: "uploads", Key: "k" })));
      }
    `);

    expect(effects).toHaveLength(1);
  });
});

describe("a bucket named somewhere other than the call site", () => {
  it("reads the default a lookup falls back to", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      const bucket = process.env.MEDIA_BUCKET ?? "media-prod";
      export async function get(key: string) {
        return client.send(new PutObjectCommand({ Bucket: bucket, Key: key }));
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("media-prod");
  });

  it("says which variable a bucket comes from when nothing settles it", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      const bucket = process.env.MEDIA_BUCKET;
      export async function get(key: string) {
        return client.send(new PutObjectCommand({ Bucket: bucket, Key: key }));
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("{bucket}");
  });

  it("writes a key whose parts are computed as unnamed holes", () => {
    const effects = effectsIn(`
      ${IMPORTS}
      declare const client: S3Client;
      export async function get(parts: string[]) {
        return client.send(new GetObjectCommand({
          Bucket: "uploads",
          Key: \`raw/\${parts.join("/")}.json\`,
        }));
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["raw/{param}.json"],
    });
  });

  it("leaves a command it does not read alone", () => {
    expect(
      effectsIn(`
        import { S3Client, GetBucketPolicyCommand } from "@aws-sdk/client-s3";
        declare const client: S3Client;
        export async function policy() {
          return client.send(new GetBucketPolicyCommand({ Bucket: "uploads" }));
        }
      `),
    ).toEqual([]);
  });
});

describe("the pack itself", () => {
  it("fires only on a file that reaches the S3 client", () => {
    expect(s3Framework()).toMatchObject({
      name: "aws-s3",
      protocol: "s3",
      requiresImport: ["@aws-sdk/client-s3"],
    });
  });

  it("prices what it declared: every link is data", () => {
    expect(s3Framework().declarations?.declarations).toEqual([
      {
        name: "s3",
        dataLinks: 4,
        functionLinks: [],
        astLinks: [],
        example:
          's3.send(new GetObjectCommand({ Bucket: "photos", Key: "a.jpg" }))',
      },
    ]);
  });

  it("emits the effect its example says it does", () => {
    const ran = runExamples(s3Framework(), (code) =>
      effectsIn(`
        ${IMPORTS}
        declare const s3: S3Client;
        export async function example() {
          return ${code};
        }
      `),
    );

    expect(ran).toHaveLength(1);
    const { semantics, interaction } = storageOf(ran[0].effects[0]);
    expect(semantics.container).toBe("photos");
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "GetObjectCommand",
      selector: ["a.jpg"],
    });
  });
});
