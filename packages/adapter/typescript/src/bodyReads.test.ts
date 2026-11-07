/**
 * A body the closure walk reaches, or a caller a request wrapper gets a
 * summary for, is read with what a discovered unit's body is read with:
 * the packs' recognizers and the run's store with its lookups. The queue
 * library is not installed and reaches the project through a file that
 * re-exports it, as in a checkout read without `node_modules`, so only
 * the store can say the queue came from it.
 */

import { describe, expect, it } from "vitest";

import { constructedFrom, messageSends, pack } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const SENDS = messageSends({
  wire: "bullmq",
  client: constructedFrom({ from: ["mq"], named: ["Queue"] }),
  messages: { each: "theInput" },
  channel: [{ argument: { of: [{ to: "receiver" }], at: 0 } }],
  body: { whole: "message" },
  routingKey: { at: 0 },
  unsettledName: "nothing",
})
  .methods({ add: { input: { at: 1 } } })
  .example('queue.add("welcome", { userId })');

const QUEUES = pack("mq", [SENDS], {
  languages: ["typescript"],
  recognizedAs: "@suss/mq-test",
});

function projectWith(files: Record<string, string>) {
  const project = createTestProject();
  project.createSourceFile("/lib/mq.ts", 'export { Queue } from "mq";');
  project.createSourceFile(
    "/queue.ts",
    'import { Queue } from "./lib/mq";\nexport const queue = new Queue("mail");',
  );
  for (const [path, text] of Object.entries(files)) {
    project.createSourceFile(path, text);
  }
  return project;
}

/** The channel of each message send on the summary with this name and kind. */
function channelsSentOn(
  summaries: readonly BehavioralSummary[],
  name: string,
  kind: BehavioralSummary["kind"],
): unknown[] {
  const summary = summaries.find(
    (one) => one.identity.name === name && one.kind === kind,
  );
  return (summary?.transitions ?? []).flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "message-send" &&
      effect.binding.semantics.name === "message-bus"
        ? [effect.binding.semantics.channel]
        : [],
    ),
  );
}

describe("a function the closure walk reaches", () => {
  it("records a send on a queue built in another file, with its channel", async () => {
    const entry: PatternPack = {
      name: "entry",
      protocol: "in-process",
      languages: ["typescript"],
      discovery: [
        {
          kind: "handler",
          match: { type: "namedExport", names: ["run"] },
          requiresImport: [],
        },
      ],
      terminals: [
        {
          kind: "return",
          match: { type: "functionFallthrough" },
          extraction: {},
        },
      ],
      inputMapping: { type: "positionalParams", params: [] },
    };
    const project = projectWith({
      "/entry.ts": `
        import { queue } from "./queue";

        function notify() {
          queue.add("later", {});
        }

        export function run() {
          notify();
        }
      `,
    });
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [entry, QUEUES],
    }).extractAll();

    expect(channelsSentOn(summaries, "notify", "library")).toEqual(["mail"]);
  });
});

describe("a caller of a request wrapper", () => {
  it("records a send on a queue built in another file, with its channel", async () => {
    const requests: PatternPack = {
      name: "axios",
      protocol: "http",
      languages: ["typescript"],
      discovery: [
        {
          kind: "client",
          match: {
            type: "clientCall",
            importModule: "axios",
            importName: "axios",
            methodFilter: ["get"],
            factoryMethods: ["create"],
          },
          bindingExtraction: {
            method: { type: "literal", value: "GET" },
            path: { type: "fromArgument", position: 0 },
          },
        },
      ],
      terminals: [
        { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      ],
      inputMapping: { type: "positionalParams", params: [] },
    };
    const project = projectWith({
      "/api.ts": `
        import axios from "axios";
        const api = axios.create({ baseURL: "/api" });

        export async function getJson(path: string) {
          const { data } = await api.get(path);
          return data;
        }
      `,
      "/client.ts": `
        import { getJson } from "./api";
        import { queue } from "./queue";

        export async function getPet(id: number) {
          await queue.add("seen", { id });
          return getJson(\`/pet/\${id}\`);
        }
      `,
    });
    const summaries = await createTypeScriptAdapter({
      project,
      frameworks: [requests, QUEUES],
    }).extractAll();

    expect(channelsSentOn(summaries, "getPet", "client")).toEqual(["mail"]);
  });
});
