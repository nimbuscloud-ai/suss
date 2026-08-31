import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject } from "@suss/test-project";

import { cloudflareWorkersFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cf-workers-"));

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write(
    "src/allTriggers.ts",
    `interface Env { GREETING_TABLE: string; TIMEOUT_MS?: string }
     export default {
       async fetch(request: Request, env: Env): Promise<Response> {
         const url = new URL(request.url);
         if (url.pathname === "/healthz") {
           return new Response("ok", { status: 200 });
         }
         const table = env.GREETING_TABLE;
         const wait = env.TIMEOUT_MS ?? "500";
         return Response.json({ table, wait }, { status: 201 });
       },
       async scheduled(controller: ScheduledController, env: Env) {
         void env.GREETING_TABLE;
       },
       async queue(batch: MessageBatch, env: Env) {
         void batch;
         void env;
       },
       async tail(events: unknown[]) {
         void events;
       },
     };`,
  );
  write(
    "src/named.ts",
    `interface Env { SERVICE_ORIGIN: string }
     async function serve(request: Request, settings: Env): Promise<Response> {
       return new Response(settings.SERVICE_ORIGIN, { status: 200 });
     }
     export default { fetch: serve };`,
  );
  write(
    "src/listener.ts",
    `addEventListener("fetch", (event: FetchEvent) => {
       event.respondWith(new Response("hi", { status: 200 }));
     });`,
  );
  write(
    "src/notAWorker.ts",
    "export default { start(a: string, b: string) { return a + b; } };",
  );
  write(
    "src/shorthand.ts",
    `interface Env { LOOKUP_TABLE: string }
     const fetch = async (request: Request, env: Env): Promise<Response> => {
       return Response.redirect(env.LOOKUP_TABLE);
     };
     const scheduled = async () => {};
     export default { fetch, scheduled };`,
  );
  write(
    "src/satisfied.ts",
    `interface Handlers { "fetch"(request: Request): Promise<Response> }
     const worker = {
       async "fetch"(request: Request) {
         return new Response(request.url);
       },
     } satisfies Handlers;
     export default worker;`,
  );
  write(
    "src/oddities.ts",
    `addEventListener("install", () => {});
     addEventListener("fetch");
     const eventName = "fetch";
     addEventListener(eventName, () => {});
     export default {
       fetch: 42,
       [Symbol.iterator]: 1,
       queue: undefined,
     };`,
  );
  write(
    "src/otherSecondArgument.ts",
    `interface Env { UPSTREAM: string }
     function label(prefix: string, item: { publicationId: string }) {
       return prefix + item.publicationId;
     }
     export default {
       async fetch(request: Request, env: Env) {
         return new Response(label(env.UPSTREAM, { publicationId: "p" }));
       },
     };`,
  );
  write(
    "src/exportedFunction.ts",
    `interface Env { UPSTREAM: string }
     export const handle = async (request: Request, env: Env) => {
       return new Response(env.UPSTREAM);
     };
     export default { fetch: handle };`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(scriptName?: string): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(root, "src/*.ts");
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [
      cloudflareWorkersFramework(
        scriptName === undefined ? {} : { scriptName },
      ),
    ],
  });
  return await adapter.extractAll();
}

function inFile(
  summaries: BehavioralSummary[],
  basename: string,
): BehavioralSummary[] {
  return summaries.filter((s) => s.location.file.endsWith(basename));
}

describe("cloudflareWorkersDiscovery", () => {
  it("emits one unit per trigger the entrypoint object defines", async () => {
    const units = inFile(await run(), "allTriggers.ts");
    expect(units.map((u) => u.identity.name).sort()).toEqual([
      "fetch",
      "queue",
      "scheduled",
      "tail",
    ]);
  });

  it("binds fetch to every method at a path the code does not state", async () => {
    const units = inFile(await run(), "allTriggers.ts");
    const fetchUnit = units.find((u) => u.identity.name === "fetch");
    expect(fetchUnit?.identity.boundaryBinding?.semantics).toMatchObject({
      name: "rest",
      method: "*",
      path: null,
    });
  });

  it("puts each non-HTTP trigger on its own wire with no channel", async () => {
    const units = inFile(await run(), "allTriggers.ts");
    const wires = new Map(
      units.map((u) => [
        u.identity.name,
        u.identity.boundaryBinding?.semantics,
      ]),
    );
    expect(wires.get("scheduled")).toMatchObject({
      name: "message-bus",
      messageBus: "cloudflare-cron",
      channel: null,
    });
    expect(wires.get("queue")).toMatchObject({
      messageBus: "cloudflare-queues",
      channel: null,
    });
    expect(wires.get("tail")).toMatchObject({
      messageBus: "cloudflare-tail",
      channel: null,
    });
  });

  it("reads the status a Worker constructs its Response with", async () => {
    const units = inFile(await run(), "allTriggers.ts");
    const fetchUnit = units.find((u) => u.identity.name === "fetch");
    const statuses = (fetchUnit?.transitions ?? [])
      .map((t) => (t.output?.type === "response" ? t.output.statusCode : null))
      .filter((code) => code !== null);
    expect(statuses).toEqual(
      expect.arrayContaining([
        { type: "literal", value: 200 },
        { type: "literal", value: 201 },
      ]),
    );
  });

  it("follows a trigger to a function declared elsewhere in the file", async () => {
    const units = inFile(await run(), "named.ts");
    expect(units.map((u) => u.identity.name)).toEqual(["fetch"]);
  });

  it("reads the service-worker registration form", async () => {
    const units = inFile(await run(), "listener.ts");
    expect(units.map((u) => u.identity.name)).toEqual(["fetch"]);
  });

  it("leaves an object export that defines no trigger alone", async () => {
    expect(inFile(await run(), "notAWorker.ts")).toEqual([]);
  });

  it("reads a shorthand property and a quoted one", async () => {
    expect(
      inFile(await run(), "shorthand.ts").map((u) => u.identity.name),
    ).toEqual(["fetch", "scheduled"]);
    expect(
      inFile(await run(), "satisfied.ts").map((u) => u.identity.name),
    ).toEqual(["fetch"]);
  });

  it("follows a trigger to a function the file also exports", async () => {
    expect(
      inFile(await run(), "exportedFunction.ts").map((u) => u.identity.name),
    ).toEqual(["fetch"]);
  });

  it("leaves a registration and a property it cannot read alone", async () => {
    expect(inFile(await run(), "oddities.ts")).toEqual([]);
  });

  it("stamps the deployable when the caller says which Worker this is", async () => {
    const units = inFile(await run("greeting-router"), "allTriggers.ts");
    for (const unit of units) {
      expect(unit.identity.deployableUnit).toEqual({
        deploymentTarget: "worker",
        instanceName: "greeting-router",
      });
    }
  });
});

describe("envBindingRecognizer", () => {
  it("records a read off the trigger's bindings argument", async () => {
    const units = inFile(await run(), "allTriggers.ts");
    const fetchUnit = units.find((u) => u.identity.name === "fetch");
    const reads = (fetchUnit?.transitions ?? [])
      .flatMap((t) => t.effects)
      .filter(
        (e) =>
          e.type === "interaction" && e.interaction.class === "config-read",
      );
    expect(reads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interaction: expect.objectContaining({
            name: "GREETING_TABLE",
            defaulted: false,
          }),
        }),
        expect.objectContaining({
          interaction: expect.objectContaining({
            name: "TIMEOUT_MS",
            defaulted: true,
          }),
        }),
      ]),
    );
  });

  it("reads the argument whatever the project calls it", async () => {
    const units = inFile(await run(), "named.ts");
    // One read reaches every branch it ran on, so the same read comes
    // back once per transition.
    const reads = [
      ...new Map(
        (units[0]?.transitions ?? [])
          .flatMap((t) => t.effects)
          .filter(
            (e) =>
              e.type === "interaction" && e.interaction.class === "config-read",
          )
          .map((e) => [JSON.stringify(e), e] as const),
      ).values(),
    ];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      interaction: { name: "SERVICE_ORIGIN" },
      binding: { semantics: { name: "runtime-config" } },
    });
  });

  it("leaves a property read on some other second argument alone", async () => {
    const units = inFile(await run(), "notAWorker.ts");
    expect(units).toEqual([]);
  });
});
