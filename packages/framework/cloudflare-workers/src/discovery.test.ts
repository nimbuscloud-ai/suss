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
    "src/overloaded.ts",
    `interface Env { SERVICE_ORIGIN: string }
     async function serve(request: Request, settings: Env): Promise<Response>;
     async function serve(request: Request, settings: Env): Promise<Response> {
       return new Response(settings.SERVICE_ORIGIN, { status: 200 });
     }
     export default { fetch: serve };`,
  );
  write(
    "src/listener.ts",
    `console.log("registering");
     addEventListener("fetch", (event: FetchEvent) => {
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
  write(
    "src/importedHandler.ts",
    `export interface Env { REMOTE_ORIGIN: string }
     export const fetch = async (request: Request, env: Env) => {
       return new Response(env.REMOTE_ORIGIN);
     };`,
  );
  write(
    "src/spreadImported.ts",
    `import { fetch } from "./importedHandler";
     const base = { fetch };
     export default { ...base };`,
  );
  write(
    "src/castBindings.ts",
    `interface Env { CAST_ORIGIN: string; ASSERTED_ORIGIN: string }
     export default {
       async fetch(request: Request, env: Env | undefined) {
         const origin = (env as Env).CAST_ORIGIN;
         return new Response(origin + env!.ASSERTED_ORIGIN);
       },
     };`,
  );
  write(
    "src/passedOn.ts",
    `interface Env { PASSED: string; LOCAL: string }
     function originOf(settings: Env) {
       return settings.PASSED;
     }
     export default {
       async fetch(request: Request, env: Env) {
         const bindings = env;
         return new Response(originOf(env) + bindings.LOCAL);
       },
     };`,
  );
  write(
    "src/nestedListener.ts",
    `export function registerLater(): void {
       addEventListener("fetch", (event: FetchEvent) => {
         event.respondWith(new Response("late"));
       });
     }`,
  );
  write(
    "src/bothForms.ts",
    `interface Env { GREETING: string }
     addEventListener("fetch", (event: FetchEvent) => {
       event.respondWith(new Response("listener"));
     });
     export default {
       async fetch(request: Request, env: Env) {
         return new Response(env.GREETING);
       },
     };`,
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

  it("follows a trigger to a function written as TS overload signatures", async () => {
    const units = inFile(await run(), "overloaded.ts");
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

  it("reads a handler spread in from an object of imported functions", async () => {
    const units = inFile(await run(), "importedHandler.ts");
    expect(units.map((u) => u.identity.name)).toEqual(["fetch"]);
  });

  it("reads an event name kept in a const and leaves what it cannot read alone", async () => {
    const units = inFile(await run(), "oddities.ts");
    expect(
      units.map((u) => [u.identity.name, u.metadata?.cloudflareWorkers]),
    ).toEqual([
      ["fetch", { trigger: "fetch", registration: "addEventListener" }],
    ]);
  });

  it("leaves a registration inside a function alone", async () => {
    expect(inFile(await run(), "nestedListener.ts")).toEqual([]);
  });

  it("makes a unit of each form when a file registers one trigger both ways", async () => {
    const units = inFile(await run(), "bothForms.ts");
    expect(
      units
        .map(
          (u) =>
            (u.metadata?.cloudflareWorkers as { registration: string })
              .registration,
        )
        .sort(),
    ).toEqual(["addEventListener", "default-export"]);
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

  it("records the value a defaulted read falls back to", async () => {
    const units = inFile(await run(), "allTriggers.ts");
    const fetchUnit = units.find((u) => u.identity.name === "fetch");
    const timeout = (fetchUnit?.transitions ?? [])
      .flatMap((t) => t.effects)
      .find(
        (e) =>
          e.type === "interaction" &&
          e.interaction.class === "config-read" &&
          e.interaction.name === "TIMEOUT_MS",
      );
    expect(timeout).toMatchObject({
      interaction: { defaulted: true, default: "500" },
    });
  });

  it("reads the bindings through a cast and a non-null assertion", async () => {
    const units = inFile(await run(), "castBindings.ts");
    const names = (units[0]?.transitions ?? [])
      .flatMap((t) => t.effects)
      .flatMap((e) =>
        e.type === "interaction" && e.interaction.class === "config-read"
          ? [e.callee]
          : [],
      );
    expect(new Set(names)).toEqual(
      new Set(["env.CAST_ORIGIN", "env.ASSERTED_ORIGIN"]),
    );
  });

  it("reads the bindings in a local set to them and in a helper they are passed to", async () => {
    const reads = inFile(await run("greeting-router"), "passedOn.ts")
      .map((unit) => [
        unit.identity.name,
        [
          ...new Set(
            unit.transitions
              .flatMap((t) => t.effects)
              .flatMap((e) =>
                e.type === "interaction" &&
                e.interaction.class === "config-read"
                  ? [e.callee]
                  : [],
              ),
          ),
        ],
      ])
      .sort();
    expect(reads).toEqual([
      ["fetch", ["env.LOCAL"]],
      ["originOf", ["env.PASSED"]],
    ]);
  });

  it("reads the bindings of a trigger written in another file", async () => {
    const units = inFile(await run(), "importedHandler.ts");
    const names = (units[0]?.transitions ?? [])
      .flatMap((t) => t.effects)
      .flatMap((e) =>
        e.type === "interaction" && e.interaction.class === "config-read"
          ? [e.interaction.name]
          : [],
      );
    expect(new Set(names)).toEqual(new Set(["REMOTE_ORIGIN"]));
  });

  it("names the Worker on a read only when the caller says which Worker this is", async () => {
    const semanticsOfReads = async (scriptName?: string) =>
      inFile(await run(scriptName), "allTriggers.ts")
        .flatMap((unit) => unit.transitions.flatMap((t) => t.effects))
        .flatMap((e) =>
          e.type === "interaction" && e.interaction.class === "config-read"
            ? [e.binding.semantics]
            : [],
        );

    expect(
      new Set((await semanticsOfReads()).map((s) => JSON.stringify(s))),
    ).toEqual(
      new Set([
        JSON.stringify({ name: "runtime-config", deploymentTarget: "worker" }),
      ]),
    );
    expect(await semanticsOfReads("greeting-router")).toContainEqual({
      name: "runtime-config",
      deploymentTarget: "worker",
      instanceName: "greeting-router",
    });
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
