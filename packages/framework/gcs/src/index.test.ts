import { type CallExpression, Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import { gcsFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// The recognizer settles a call by where the operation is declared, so
// a fixture needs the client library on disk to resolve against.
const GCS_TYPES = `
  export declare class File {
    download(): Promise<[Buffer]>;
    createReadStream(): unknown;
    getMetadata(): Promise<[unknown]>;
    exists(): Promise<[boolean]>;
    save(contents: unknown, options?: unknown): Promise<void>;
    delete(): Promise<void>;
    copy(destination: File): Promise<void>;
    move(destination: File): Promise<void>;
    setMetadata(metadata: unknown): Promise<unknown>;
    getSignedUrl(config: unknown): Promise<[string]>;
  }
  export declare class Bucket {
    file(path: string): File;
    upload(path: string, options?: unknown): Promise<unknown>;
    getFiles(query?: unknown): Promise<[File[]]>;
  }
  export declare class Storage {
    constructor(options?: unknown);
    bucket(name: string): Bucket;
  }
`;

function effectsIn(source: string): Effect[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/@google-cloud/storage/package.json",
    JSON.stringify({ name: "@google-cloud/storage", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/@google-cloud/storage/index.d.ts",
    GCS_TYPES,
  );
  const sourceFile: SourceFile = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const recognizers = gcsFramework().invocationRecognizers ?? [];
  const effects: Effect[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = {
      call: node as CallExpression,
      sourceFile,
      extractArgs: () => [],
      isImportedFrom: () => false,
      resolveWrittenValue: (value: Node) => store.resolveWrittenValue(value),
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

const CLIENT = `import { Storage } from "@google-cloud/storage";\ndeclare const storage: Storage;`;

describe("a call down a bucket and file chain", () => {
  it("reads the bucket and the object a download reaches", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function fetchReport(id: string) {
        return storage.bucket("reports-prod").file(\`reports/\${id}.pdf\`).download();
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "gcs",
      scope: "default",
      container: "reports-prod",
      accessPath: null,
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "download",
      fields: [],
      selector: ["reports/{id}.pdf"],
    });
  });

  it("reads a save as a write", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function store(path: string, body: Buffer) {
        await storage.bucket("uploads").file(path).save(body);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "save",
    });
  });

  it("reads a bucket named by a field the constructor set", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export class RawStore {
        private readonly bucketName: string;
        constructor(stage: string) {
          this.bucketName = \`\${stage}-raw\`;
        }
        async read(tenantId: string, runId: string) {
          return storage
            .bucket(this.bucketName)
            .file(\`\${tenantId}/\${runId}/pull.json\`)
            .download();
        }
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("{stage}-raw");
    expect(interaction).toMatchObject({
      selector: ["{tenantId}/{runId}/pull.json"],
    });
  });

  it("follows a bucket written into a variable first", () => {
    const effects = effectsIn(`
      ${CLIENT}
      const bucket = storage.bucket("media");
      export async function remove(path: string) {
        await bucket.file(path).delete();
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("media");
  });

  it("reads a signed URL as whatever the caller signed for", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function uploadUrl(path: string) {
        return storage.bucket("uploads").file(path).getSignedUrl({
          version: "v4",
          action: "write",
          expires: Date.now() + 900_000,
        });
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "getSignedUrl",
    });
  });

  it("reads a signed URL that says nothing as a read", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function url(path: string) {
        return storage.bucket("uploads").file(path).getSignedUrl({});
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({ kind: "read" });
  });

  it("reads a listing as a read of the bucket, with no object", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function list() {
        return storage.bucket("uploads").getFiles({ prefix: "raw/" });
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBe("uploads");
    expect(interaction).not.toHaveProperty("selector");
  });

  it("states no bucket when the chain never says which one", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function read(name: string, path: string) {
        return storage.bucket(name).file(path).download();
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBeNull();
    expect(interaction).not.toHaveProperty("selector");
  });

  it("leaves a same-named method on something else alone", () => {
    expect(
      effectsIn(`
        declare const cache: { file(path: string): { download(): Promise<void> } };
        export async function read() {
          return cache.file("x").download();
        }
      `),
    ).toEqual([]);
  });
});

describe("the pack itself", () => {
  it("fires only on a file that reaches the client library", () => {
    expect(gcsFramework()).toMatchObject({
      name: "gcs",
      protocol: "gcs",
      requiresImport: ["@google-cloud/storage"],
    });
  });
});
