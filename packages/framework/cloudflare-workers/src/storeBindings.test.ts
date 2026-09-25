import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node as TsNode } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject } from "@suss/test-project";

import { cloudflareWorkersFramework } from "./index.js";
import { storeBindingRecognizer } from "./storeBindings.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cf-stores-"));

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write(
    "src/stores.ts",
    `interface Env {
       SESSIONS: KVNamespace;
       ARCHIVE: R2Bucket;
       LEDGER: D1Database;
       GREETING: string;
     }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         const current = await env.SESSIONS.get("session:current");
         await env.SESSIONS.put("session:current", "started");
         const report = await env.ARCHIVE.get("reports/latest.csv");
         const rows = await env.LEDGER
           .prepare("SELECT total FROM entries WHERE day = ?")
           .bind("today")
           .all();
         await env.LEDGER.prepare("INSERT INTO entries (day) VALUES (?)");
         return Response.json({ current, report, rows, hi: env.GREETING });
       },
     };`,
  );
  write(
    "src/heldFirst.ts",
    `interface Env { SESSIONS: KVNamespace }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         const sessions = env.SESSIONS;
         await sessions.delete("session:stale");
         return new Response("ok");
       },
     };`,
  );
  write(
    "src/unreadable.ts",
    `interface Env { LEDGER: D1Database }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         await env.LEDGER.prepare(buildQuery());
         return new Response("ok");
       },
     };
     declare function buildQuery(): string;`,
  );
  write(
    "src/functionReturnedStatement.ts",
    `interface Env { LEDGER: D1Database }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         await env.LEDGER.prepare(ledgerQuery());
         return new Response("ok");
       },
     };
     function ledgerQuery(): string {
       return "SELECT * FROM ledger";
     }`,
  );
  write(
    "src/notAStore.ts",
    `interface Env { CLIENT: { get(key: string): string } }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         return new Response(env.CLIENT.get("greeting"));
       },
     };`,
  );
  write(
    "src/untypedBindings.ts",
    `export default {
       async scheduled(controller: ScheduledController, env: { AUDIT }) {
         await env.AUDIT.get("k");
       },
     };`,
  );
  write(
    "src/classBindings.ts",
    `class EnvBag {
       SESSIONS: KVNamespace = undefined as unknown as KVNamespace;
     }
     export default {
       async fetch(request: Request, env: EnvBag): Promise<Response> {
         await env.SESSIONS.get("k");
         return new Response("ok");
       },
     };`,
  );
  write(
    "src/typedStores.ts",
    `type Sessions = KVNamespace & { readonly region: string };
     type MaybeArchive = R2Bucket | undefined;
     interface Env {
       JOINED: KVNamespace & { readonly region: string };
       OPTIONAL: KVNamespace | undefined;
       ALIASED_JOIN: Sessions;
       ALIASED_OPTIONAL: MaybeArchive;
     }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         await env.JOINED.get("a");
         await env.OPTIONAL?.get("b");
         await env.ALIASED_JOIN.get("c");
         await env.ALIASED_OPTIONAL?.get("d");
         return new Response("ok");
       },
     };`,
  );
  write(
    "src/abstains.ts",
    `interface Env { SESSIONS: KVNamespace; LEDGER: D1Database }
     declare const elsewhere: Env;
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         await env.SESSIONS.getMany(["a", "b"]);
         await env.LEDGER.batch([]);
         await env.LEDGER.prepare("NOT A STATEMENT ;;;");
         await env.LEDGER.prepare();
         await elsewhere.SESSIONS.get("k");
         return new Response("ok");
       },
     };`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(root, "src/*.ts");
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [cloudflareWorkersFramework()],
  });
  return await adapter.extractAll();
}

/**
 * The distinct storage accesses a file's units make. One call reaches
 * every branch it ran on, so reading the transitions end to end would
 * count the same access once per branch.
 */
function storageEffects(
  summaries: BehavioralSummary[],
  basename: string,
): Effect[] {
  const distinct = new Map<string, Effect>();
  for (const summary of summaries.filter((s) =>
    s.location.file.endsWith(basename),
  )) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access"
        ) {
          distinct.set(JSON.stringify(effect), effect);
        }
      }
    }
  }
  return [...distinct.values()];
}

/** The binding a storage access reaches, and which kind of store it is. */
function storeOf(effect: Effect): string {
  if (effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect.type}`);
  }
  const { semantics } = effect.binding;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  return `${semantics.container} ${semantics.storageSystem}`;
}

describe("storeBindingRecognizer", () => {
  it("reads each store by the type its Env declaration states", async () => {
    const effects = storageEffects(await run(), "stores.ts");
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({
            semantics: expect.objectContaining({
              storageSystem: "cloudflare-kv",
              container: "SESSIONS",
            }),
          }),
          interaction: expect.objectContaining({
            kind: "read",
            operation: "get",
            selector: ["session:current"],
          }),
        }),
        expect.objectContaining({
          interaction: expect.objectContaining({
            kind: "write",
            operation: "put",
          }),
        }),
        expect.objectContaining({
          binding: expect.objectContaining({
            semantics: expect.objectContaining({
              storageSystem: "r2",
              container: "ARCHIVE",
            }),
          }),
          interaction: expect.objectContaining({
            kind: "read",
            selector: ["reports/latest.csv"],
          }),
        }),
      ]),
    );
  });

  it("judges a D1 statement by what its SQL does", async () => {
    const d1 = storageEffects(await run(), "stores.ts").filter(
      (e) =>
        e.type === "interaction" &&
        e.binding.semantics.name === "storage" &&
        e.binding.semantics.storageSystem === "d1",
    );
    const kinds = d1.map((e) =>
      e.type === "interaction" && e.interaction.class === "storage-access"
        ? e.interaction.kind
        : null,
    );
    expect(kinds.sort()).toEqual(["read", "write"]);
  });

  it("follows a binding written into a variable first", async () => {
    const effects = storageEffects(await run(), "heldFirst.ts");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      binding: { semantics: { container: "SESSIONS" } },
      interaction: { kind: "write", operation: "delete" },
    });
  });

  it("records nothing for a statement nobody can read", async () => {
    expect(storageEffects(await run(), "unreadable.ts")).toEqual([]);
  });

  it("reads a statement a project function returns", async () => {
    const effects = storageEffects(await run(), "functionReturnedStatement.ts");
    expect(effects).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({
          semantics: expect.objectContaining({
            storageSystem: "d1",
            container: "LEDGER",
          }),
        }),
        interaction: expect.objectContaining({
          kind: "read",
          operation: "prepare",
        }),
      }),
    ]);
  });

  it("leaves a binding whose type is not a store alone", async () => {
    expect(storageEffects(await run(), "notAStore.ts")).toEqual([]);
  });

  it("leaves a binding whose declaration states no readable type alone", async () => {
    expect(storageEffects(await run(), "untypedBindings.ts")).toEqual([]);
  });

  it("reads a store type written on a class field", async () => {
    const stores = storageEffects(await run(), "classBindings.ts").map(storeOf);
    expect(stores).toEqual(["SESSIONS cloudflare-kv"]);
  });

  it("reads a store type through an intersection, a union and an alias", async () => {
    const stores = storageEffects(await run(), "typedStores.ts").map(storeOf);
    expect(stores.sort()).toEqual([
      "ALIASED_JOIN cloudflare-kv",
      "ALIASED_OPTIONAL r2",
      "JOINED cloudflare-kv",
      "OPTIONAL cloudflare-kv",
    ]);
  });

  it("abstains from methods, statements and receivers it cannot settle", async () => {
    expect(storageEffects(await run(), "abstains.ts")).toEqual([]);
  });

  it("reads a call when the context has no resolver", () => {
    const project = createFixtureProject(root, "src/*.ts");
    const sf = project.getSourceFileOrThrow(path.join(root, "src/stores.ts"));
    const effects: Effect[] = [];
    sf.forEachDescendant((node) => {
      if (!TsNode.isCallExpression(node)) {
        return;
      }
      const emitted = storeBindingRecognizer(node, {});
      if (emitted !== null) {
        effects.push(...emitted);
      }
    });
    expect(effects.length).toBeGreaterThan(0);
  });

  it("leaves an env argument alone outside a trigger when there is no resolver", () => {
    const project = createFixtureProject(root, "src/*.ts");
    const sf = project.createSourceFile(
      path.join(root, "src/notATrigger.ts"),
      `interface Env { SESSIONS: KVNamespace }
       export default {
         async warm(request: Request, env: Env): Promise<void> {
           await env.SESSIONS.get("k");
         },
       };`,
    );
    const calls = sf.getDescendants().filter(TsNode.isCallExpression);
    expect(calls.map((call) => storeBindingRecognizer(call, {}))).toEqual([
      null,
    ]);
  });

  it("keeps the config-read beside the storage access", async () => {
    const reads = (await run())
      .filter((s) => s.location.file.endsWith("stores.ts"))
      .flatMap((s) => s.transitions)
      .flatMap((t) => t.effects)
      .filter(
        (e) =>
          e.type === "interaction" && e.interaction.class === "config-read",
      )
      .map((e) =>
        e.type === "interaction" && e.interaction.class === "config-read"
          ? e.interaction.name
          : null,
      );
    expect(reads).toContain("SESSIONS");
    expect(reads).toContain("GREETING");
  });
});

describe("storeBindingRecognizer with the store types declared", () => {
  const typedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cf-typed-"));

  beforeAll(() => {
    const files: Record<string, string> = {
      // What `wrangler types` generates: the store types as globals.
      "src/workerConfiguration.d.ts": `
        declare interface KVNamespace { get(key: string): Promise<string | null> }
        declare interface R2Bucket { get(key: string): Promise<unknown> }`,
      "src/worker.ts": `
        type Sessions = KVNamespace & { readonly region: string };
        type MaybeArchive = R2Bucket | undefined;
        interface TaggedSessions extends KVNamespace { readonly tag: string }
        interface Env {
          PLAIN: KVNamespace;
          EXTENDED: TaggedSessions;
          JOINED: KVNamespace & { readonly region: string };
          ALIASED_JOIN: Sessions;
          ALIASED_OPTIONAL: MaybeArchive;
        }
        export default {
          async fetch(request: Request, env: Env): Promise<Response> {
            await env.PLAIN.get("a");
            await env.EXTENDED.get("e");
            await env.JOINED.get("b");
            await env.ALIASED_JOIN.get("c");
            await env.ALIASED_OPTIONAL?.get("d");
            return new Response("ok");
          },
        };`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(typedRoot, rel)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(typedRoot, rel), content);
    }
  });

  afterAll(() => {
    fs.rmSync(typedRoot, { recursive: true, force: true });
  });

  it("reads the store type the checker resolves, through an extension too", async () => {
    const adapter = createTypeScriptAdapter({
      project: createFixtureProject(typedRoot, "src/*.ts"),
      frameworks: [cloudflareWorkersFramework()],
    });
    const summaries = await adapter.extractAll();
    const stores = storageEffects(summaries, "worker.ts").map(storeOf);
    expect(stores.sort()).toEqual([
      "ALIASED_JOIN cloudflare-kv",
      "ALIASED_OPTIONAL r2",
      "EXTENDED cloudflare-kv",
      "JOINED cloudflare-kv",
      "PLAIN cloudflare-kv",
    ]);
  });
});
