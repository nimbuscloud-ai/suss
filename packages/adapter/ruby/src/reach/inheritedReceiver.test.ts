/**
 * A service's class method written on its base class and run on the
 * subclass a controller calls it on, read by this adapter alone over the
 * project the CLI's integration test also reads.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { railsTestPack } from "../__fixtures__/railsControllerPattern.js";
import { extractRubyProject, findRubyFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = path.resolve(
  __dirname,
  "../../../../../fixtures/inherited-receiver-ruby",
);

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(root),
    packs: [
      railsTestPack({
        routesFor: (_controller, action) => [
          { method: "POST", path: `/invoices/${action}` },
        ],
      }),
    ],
    workspaceRoot: root,
  });
  return summaries;
}

/** The id each call written as `callee` in the unit with this id links to. */
function linkOf(
  summaries: BehavioralSummary[],
  id: string,
  callee: string,
): string | undefined {
  const unit = summaries.find((summary) => summary.identity.id === id);
  for (const effect of (unit?.transitions ?? []).flatMap((t) => t.effects)) {
    if (effect.type === "invocation" && effect.callee === callee) {
      return effect.summary;
    }
  }
  return undefined;
}

const CONTROLLER = "app/controllers/invoices_controller.rb::InvoicesController";
const BASE = "app/services/base_service.rb";
const CREATE = "app/services/invoices/create_service.rb";
const VOID = "app/services/invoices/void_service.rb";

describe("a Ruby class method run on the subclass it was called on", () => {
  it("makes one of the subclass with `new` and runs the subclass's `call`", async () => {
    const summaries = await extract();
    const onCreate = linkOf(
      summaries,
      `${CONTROLLER}.create`,
      "Invoices::CreateService.call",
    );

    expect(onCreate).toBe(`${BASE}::Invoices::CreateService.call`);
    expect(
      summaries.find((summary) => summary.identity.id === onCreate)
        ?.receiverClass,
    ).toEqual({ file: CREATE, name: "Invoices::CreateService" });
    expect(linkOf(summaries, onCreate ?? "", "new(...).call")).toBe(
      `${CREATE}::Invoices::CreateService.call`,
    );
    // The method on its own class keeps the base class's `call`.
    const own = summaries.find(
      (summary) =>
        summary.location.file === BASE &&
        summary.location.range.start === 4 &&
        summary.receiverClass === undefined,
    );
    const ownCall = summaries.find(
      (summary) =>
        summary.identity.id ===
        linkOf(summaries, own?.identity.id ?? "", "new(...).call"),
    );
    expect(ownCall?.location).toMatchObject({
      file: BASE,
      range: { start: 29 },
    });
  });

  it("follows a local made with `new`, a factory's result, a bare class-method call and `self.class`", async () => {
    const summaries = await extract();
    const logged = linkOf(
      summaries,
      `${CONTROLLER}.create_logged`,
      "Invoices::CreateService.call_logged",
    );
    const withLog = linkOf(summaries, logged ?? "", "service.call_with_log");

    expect(linkOf(summaries, withLog ?? "", "call")).toBe(
      `${CREATE}::Invoices::CreateService.call`,
    );
    expect(
      linkOf(
        summaries,
        `${CONTROLLER}.create_built`,
        "Invoices::CreateService.build(amount: params[:amount]).call",
      ),
    ).toBe(`${CREATE}::Invoices::CreateService.call`);
    const builtInside = linkOf(
      summaries,
      `${CONTROLLER}.create_built_inside`,
      "Invoices::CreateService.call_built",
    );
    expect(linkOf(summaries, builtInside ?? "", "build(**args).call")).toBe(
      `${CREATE}::Invoices::CreateService.call`,
    );
    const later = linkOf(
      summaries,
      `${CONTROLLER}.create_later`,
      "Invoices::CreateService.perform_later",
    );
    expect(linkOf(summaries, later ?? "", "perform")).toBe(
      `${CREATE}::Invoices::CreateService.perform`,
    );
    const retry = linkOf(
      summaries,
      `${CONTROLLER}.retry_void`,
      "Invoices::VoidService.new(id: params[:id]).retry_once",
    );
    const again = linkOf(summaries, retry ?? "", "self.class.call");
    expect(linkOf(summaries, again ?? "", "new(...).call")).toBe(
      `${VOID}::Invoices::VoidService.call`,
    );
  });

  it("gives a method that does the same on every subclass one summary", async () => {
    const summaries = await extract();

    expect(
      summaries
        .filter((summary) => summary.identity.name === "log_start")
        .map((summary) => summary.receiverClass),
    ).toEqual([undefined]);
  });
});
