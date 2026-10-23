/**
 * A static method written on a base class and run on the subclass a
 * caller sends it to, read by this adapter over the services the CLI's
 * integration test also reads, with callers written here.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const fixture = path.resolve(
  __dirname,
  "../../../../../fixtures/inherited-receiver/src",
);

const CALLERS = `
import { BaseService, CreateInvoice, VoidInvoice } from "./services";

class Helper {
  static run() {}
}

export function create() {
  return CreateInvoice.call({ amount: 1 });
}

export function createLogged() {
  return CreateInvoice.callLogged({ amount: 1 });
}

export function voidOne() {
  return VoidInvoice.call({ id: 1 });
}

export function onBase() {
  return BaseService.call({ amount: 1 });
}

export function onInstance() {
  const service = new CreateInvoice({ amount: 1 });
  return service.runWithLog();
}

export function unrelated() {
  return Helper.run();
}

class Describable {
  describe() {
    return "invoice";
  }
}

// The class takes Describable's members by declaration merging, so it
// has \`describe\` without inheriting it.
interface Tagged extends Describable {}
class Tagged {}

export function tagged() {
  return new Tagged().describe();
}

class Job {
  static enqueue() {
    return this.perform();
  }

  static perform(): string {
    return "job";
  }
}

class NightlyJob extends Job {
  static override perform() {
    return "nightly";
  }
}

export function nightly() {
  return NightlyJob.enqueue();
}
`;

const callers: PatternPack = {
  name: "callers",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [
    {
      kind: "library",
      match: {
        type: "namedExport",
        names: [
          "create",
          "createLogged",
          "voidOne",
          "onBase",
          "onInstance",
          "unrelated",
          "tagged",
          "nightly",
        ],
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "allPositional" },
};

async function extract(): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const name of ["services.ts", "db.ts"]) {
    project.createSourceFile(
      `/src/${name}`,
      fs.readFileSync(path.join(fixture, name), "utf8"),
    );
  }
  project.createSourceFile("/src/callers.ts", CALLERS);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [callers],
    cacheDir: null,
  });
  return await adapter.extractAll();
}

function linkOf(
  summaries: BehavioralSummary[],
  unit: BehavioralSummary | undefined,
  callee: string,
): BehavioralSummary | undefined {
  for (const effect of (unit?.transitions ?? []).flatMap((t) => t.effects)) {
    if (effect.type === "invocation" && effect.callee === callee) {
      return summaries.find((one) => one.identity.id === effect.summary);
    }
  }
  return undefined;
}

function named(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find(
    (summary) =>
      summary.identity.name === name && summary.receiverClass === undefined,
  );
}

/** Which `run` a summary is, by the line it starts on in the fixture's services. */
const CREATE_RUN = 33;
const VOID_RUN = 39;
const BASE_RUN = 20;

describe("a TypeScript static method run on the subclass it was called on", () => {
  it("makes one of the subclass with `new this()` and runs the subclass's `run`", async () => {
    const summaries = await extract();
    const onCreate = linkOf(
      summaries,
      named(summaries, "create"),
      "CreateInvoice.call",
    );

    expect(onCreate?.receiverClass).toEqual({
      file: "/src/services.ts",
      name: "CreateInvoice",
    });
    expect(onCreate?.identity.exportPath).toEqual(["CreateInvoice", "call"]);
    expect(
      linkOf(summaries, onCreate, "new this(args).run")?.location.range.start,
    ).toBe(CREATE_RUN);
    const onVoid = linkOf(
      summaries,
      named(summaries, "voidOne"),
      "VoidInvoice.call",
    );
    expect(
      linkOf(summaries, onVoid, "new this(args).run")?.location.range.start,
    ).toBe(VOID_RUN);
  });

  it("follows a const made with `new this`, and `this.run` in an instance method a subclass inherits", async () => {
    const summaries = await extract();
    const logged = linkOf(
      summaries,
      named(summaries, "createLogged"),
      "CreateInvoice.callLogged",
    );
    const withLog = linkOf(summaries, logged, "service.runWithLog");

    expect(withLog?.receiverClass?.name).toBe("CreateInvoice");
    expect(linkOf(summaries, withLog, "this.run")?.location.range.start).toBe(
      CREATE_RUN,
    );
    const onInstance = linkOf(
      summaries,
      named(summaries, "onInstance"),
      "service.runWithLog",
    );
    expect(onInstance?.identity.id).toBe(withLog?.identity.id);
  });

  it("runs `this.perform()` in an inherited static on the subclass's own static", async () => {
    const summaries = await extract();
    const enqueue = linkOf(
      summaries,
      named(summaries, "nightly"),
      "NightlyJob.enqueue",
    );

    expect(enqueue?.receiverClass?.name).toBe("NightlyJob");
    expect(
      linkOf(summaries, enqueue, "this.perform")?.identity.exportPath,
    ).toEqual(["perform"]);
    expect(
      linkOf(summaries, enqueue, "this.perform")?.location.range.start,
    ).toBe(
      CALLERS.split("\n").findIndex((line) =>
        line.includes("static override perform"),
      ) + 1,
    );
  });

  it("keeps the base class's own summary for a call on the base class", async () => {
    const summaries = await extract();
    const own = linkOf(
      summaries,
      named(summaries, "onBase"),
      "BaseService.call",
    );

    expect(own?.receiverClass).toBeUndefined();
    expect(
      linkOf(summaries, own, "new this(args).run")?.location.range.start,
    ).toBe(BASE_RUN);
    expect(
      linkOf(summaries, named(summaries, "unrelated"), "Helper.run")
        ?.receiverClass,
    ).toBeUndefined();
    // A member a class merges in without inheriting it runs as its own.
    const describe = linkOf(
      summaries,
      named(summaries, "tagged"),
      "new Tagged().describe",
    );
    expect(describe?.identity.name).toBe("describe");
    expect(describe?.receiverClass).toBeUndefined();
    expect(
      summaries.filter((summary) => summary.identity.name === "logStart"),
    ).toHaveLength(1);
  });
});
