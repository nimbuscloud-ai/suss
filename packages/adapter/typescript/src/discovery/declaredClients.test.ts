import { describe, expect, it } from "vitest";

import { readHttpMetadata } from "@suss/behavioral-ir";
import { httpRequests, imported, requestRecognizersOf } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/** An axios-like client that follows redirects unless `maxRedirects` is 0. */
const clientPack: PatternPack = {
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
        options: { position: 1 },
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
  redirectDelivery: "followed",
  redirectOption: { name: "maxRedirects", handsBack: [0] },
};

async function deliveries(
  source: string,
  pack: PatternPack = clientPack,
): Promise<Record<string, string | undefined>> {
  const project = createTestProject();
  project.createSourceFile("client.ts", source);
  const adapter = createTypeScriptAdapter({ project, frameworks: [pack] });
  const summaries = await adapter.extractAll();
  return Object.fromEntries(
    summaries
      .filter((s) => s.kind === "client")
      .map((s: BehavioralSummary) => [
        s.identity.name,
        readHttpMetadata(s)?.redirectDelivery,
      ]),
  );
}

describe("a clientCall pattern read as a request chain, and its redirect option", () => {
  it("reads the option off the call, and off the instance when the call says nothing", async () => {
    expect(
      await deliveries(`
        import axios from "axios";
        const strict = axios.create({ maxRedirects: 0 });

        export async function onTheCall() {
          return axios.get("/a", { maxRedirects: 0 });
        }

        export async function onTheInstance() {
          return strict.get("/b");
        }

        export async function overriddenOnTheCall() {
          return strict.get("/c", { maxRedirects: 3 });
        }
      `),
    ).toEqual({
      onTheCall: "response",
      onTheInstance: "response",
      overriddenOnTheCall: "followed",
    });
  });

  it("leaves the pack's default when the value cannot be settled", async () => {
    expect(
      await deliveries(`
        import axios from "axios";

        export async function fromAParameter(limit: number) {
          return axios.get("/a", { maxRedirects: limit });
        }

        export async function throughASpread(base: object) {
          return axios.get("/b", { ...base });
        }

        export async function withNoOptions() {
          return axios.get("/c");
        }
      `),
    ).toEqual({
      fromAParameter: "followed",
      throughASpread: "followed",
      withNoOptions: "followed",
    });
  });

  it("does nothing for a pack that names no option", async () => {
    const { redirectOption: _omit, ...withoutOption } = clientPack;
    expect(
      await deliveries(
        `
        import axios from "axios";

        export async function onTheCall() {
          return axios.get("/a", { maxRedirects: 0 });
        }
      `,
        withoutOption,
      ),
    ).toEqual({ onTheCall: "followed" });
  });
});

describe("a pack that declares its requests with httpRequests", () => {
  const REQUESTS = httpRequests({
    client: imported({ from: ["relayhttp"], named: ["default"] }),
  })
    .methods({
      post: { sends: "POST", url: { at: 0 } },
      get: { sends: "GET", url: { at: 0 } },
    })
    .calls({ sends: "PUT", url: { at: 0 } });

  const declaredPack: PatternPack = {
    name: "relay",
    protocol: "http",
    languages: ["typescript"],
    discovery: [],
    requestRecognizers: requestRecognizersOf([REQUESTS]),
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
  };

  it("keeps one unit per function, the first the table lists, and a call of the client itself after every entry", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "client.ts",
      `
      import relay from "relayhttp";

      declare function makeClient(): (url: string) => unknown;

      export function both() {
        relay.get("/orders");
        return relay.post("/orders");
      }

      export function replace() {
        return relay("/orders/1");
      }

      export function readFirst() {
        makeClient()("/elsewhere");
        relay("/orders/1");
        return relay.get("/orders/1");
      }

      export const later = [1].map(() => relay.get("/later"));
    `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [declaredPack],
    });
    const requests = (await adapter.extractAll())
      .filter((s) => s.kind === "client")
      .map((s) => {
        const semantics = s.identity.boundaryBinding?.semantics;
        return semantics?.name === "rest"
          ? `${s.identity.name} ${semantics.method} ${semantics.path}`
          : `${s.identity.name} no binding`;
      })
      .sort();

    // A function passed straight to a call is named by the method it calls.
    expect(requests).toEqual([
      "both POST /orders",
      "get GET /later",
      "readFirst GET /orders/1",
      "replace PUT /orders/1",
    ]);
  });
});
