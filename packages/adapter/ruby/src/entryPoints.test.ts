import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { unitInvocationBinding } from "@suss/behavioral-ir";

import { extractRubyProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { DeclaredEntryPoint } from "@suss/extractor";
import type { RubyPack } from "./pack.js";

const FILE = "app.rb";

const SOURCE = [
  "def handler(event:, context:)",
  "  lookup",
  "end",
  "",
  "def lookup",
  '  ENV["TABLE_NAME"]',
  "end",
  "",
  "module Billing",
  "  class Handler",
  "    def self.process(event:, context:)",
  "      nil",
  "    end",
  "  end",
  "end",
  "",
  "class Billing::Handler",
  "end",
  "",
  "class Empty",
  "end",
  "",
].join("\n");

function entry(name: string, withMetadata: boolean): DeclaredEntryPoint {
  return {
    name,
    units: [
      {
        kind: "handler",
        name: `Fn.${name}`,
        binding: unitInvocationBinding({
          recognition: "entry-inline-test-pack",
          deploymentTarget: "lambda",
          instanceName: "Fn",
        }),
        deployableUnit: { deploymentTarget: "lambda", instanceName: "Fn" },
        ...(withMetadata ? { metadata: { entryTest: { name } } } : {}),
      },
    ],
  };
}

/** Inline rather than the shipped Lambda pack, which depends on this package. */
const entryPack: RubyPack = {
  name: "entry-inline-test-pack",
  protocol: "http",
  discovery: [],
  entryPoints: (file) =>
    path.basename(file) === FILE
      ? [
          entry("handler", true),
          entry("Billing::Handler.process", false),
          entry("missing", false),
          entry("Missing.run", false),
          entry("Empty.run", false),
        ]
      : [],
};

let root: string;
let summaries: BehavioralSummary[] = [];

beforeAll(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-entry-points-")),
  );
  fs.writeFileSync(path.join(root, FILE), SOURCE);
  ({ summaries } = await extractRubyProject({
    files: [path.join(root, FILE)],
    packs: [entryPack, { name: "no-entries", protocol: "http", discovery: [] }],
    workspaceRoot: root,
    cacheDir: null,
  }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const named = (name: string): BehavioralSummary | undefined =>
  summaries.find((summary) => summary.identity.name === name);

describe("a method a deploy manifest points at", () => {
  it("builds the unit on a method at the top of the file, with its deployable unit and metadata", () => {
    const handler = named("Fn.handler");

    expect(handler?.kind).toBe("handler");
    expect(handler?.identity.exportPath).toEqual(["handler"]);
    expect(handler?.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "Fn",
    });
    expect(handler?.metadata?.entryTest).toEqual({ name: "handler" });
  });

  it("starts the call walk, so the method it calls gets a summary", () => {
    expect(named("lookup")).toBeDefined();
  });

  it("finds a class method by its namespaced class, even where the class is opened again", () => {
    const process = named("Fn.Billing::Handler.process");

    expect(process?.identity.exportPath).toEqual([
      "Billing::Handler",
      "process",
    ]);
    expect(process?.metadata?.entryTest).toBeUndefined();
  });

  it("builds nothing for a name the file does not define", () => {
    expect(named("Fn.missing")).toBeUndefined();
    expect(named("Fn.Missing.run")).toBeUndefined();
    expect(named("Fn.Empty.run")).toBeUndefined();
  });
});
