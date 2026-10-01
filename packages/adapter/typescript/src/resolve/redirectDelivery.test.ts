import { describe, expect, it } from "vitest";

import { readHttpMetadata } from "@suss/behavioral-ir";
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

describe("redirectDeliveryAtCall", () => {
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
