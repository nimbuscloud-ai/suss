/**
 * A service's classmethod written on its base class and run on the
 * subclass a route calls it on, read by this adapter alone over the
 * project the CLI's integration test also reads.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { fastapiTestPack } from "../__fixtures__/fastapiPattern.js";
import { extractPythonProject, findPythonFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = path.resolve(
  __dirname,
  "../../../../../fixtures/inherited-receiver-python",
);

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [fastapiTestPack()],
    roots: [root],
    workspaceRoot: root,
  });
  return summaries;
}

/** The summary each call written as `callee` in a unit links to. */
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

function route(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

/** The class and method a summary describes, as `Class.method`, with the subclass it runs on. */
function described(summary: BehavioralSummary | undefined): string {
  const runsOn = summary?.receiverClass?.name;
  const path = summary?.identity.exportPath?.join(".") ?? "?";
  return runsOn === undefined ? path : `${path} on ${runsOn}`;
}

describe("a Python classmethod run on the subclass it was called on", () => {
  it("makes one of the subclass with `cls(...)` and runs the subclass's `run`", async () => {
    const summaries = await extract();
    const onCreate = linkOf(
      summaries,
      route(summaries, "create"),
      "CreateInvoice.call",
    );

    expect(described(onCreate)).toBe("CreateInvoice.call on CreateInvoice");
    expect(onCreate?.receiverClass?.file).toBe("app/services.py");
    expect(described(linkOf(summaries, onCreate, "cls(**kwargs).run"))).toBe(
      "CreateInvoice.run",
    );
    expect(described(linkOf(summaries, onCreate, "cls"))).toBe(
      "BaseService.__init__",
    );
    const onVoid = linkOf(
      summaries,
      route(summaries, "void"),
      "VoidInvoice.call",
    );
    expect(described(linkOf(summaries, onVoid, "cls(**kwargs).run"))).toBe(
      "VoidInvoice.run",
    );
  });

  it("follows a local made with `cls`, what a classmethod returns, and `cls.perform`", async () => {
    const summaries = await extract();
    const logged = linkOf(
      summaries,
      route(summaries, "create_logged"),
      "CreateInvoice.call_logged",
    );
    const withLog = linkOf(summaries, logged, "service.run_with_log");

    expect(described(withLog)).toBe(
      "CreateInvoice.run_with_log on CreateInvoice",
    );
    expect(described(linkOf(summaries, withLog, "self.run"))).toBe(
      "CreateInvoice.run",
    );
    expect(
      described(
        linkOf(
          summaries,
          route(summaries, "create_built"),
          "CreateInvoice.build(amount=amount).run",
        ),
      ),
    ).toBe("CreateInvoice.run");
    const builtInside = linkOf(
      summaries,
      route(summaries, "create_built_inside"),
      "CreateInvoice.call_built",
    );
    expect(
      described(linkOf(summaries, builtInside, "cls.build(**kwargs).run")),
    ).toBe("CreateInvoice.run");
    const later = linkOf(
      summaries,
      route(summaries, "create_later"),
      "CreateInvoice.perform_later",
    );
    expect(described(linkOf(summaries, later, "cls.perform"))).toBe(
      "CreateInvoice.perform",
    );
  });

  it("keeps the base class's own summary on the base class's methods", async () => {
    const summaries = await extract();
    const own = summaries.find(
      (summary) =>
        described(summary) === "BaseService.call" &&
        summary.receiverClass === undefined,
    );

    expect(described(linkOf(summaries, own, "cls(**kwargs).run"))).toBe(
      "BaseService.run",
    );
    expect(
      summaries.filter((summary) => summary.identity.name === "log_start"),
    ).toHaveLength(1);
  });
});
