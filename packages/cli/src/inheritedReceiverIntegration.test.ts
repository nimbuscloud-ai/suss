/**
 * A method written on a base class and run on a subclass, through the
 * extract a user runs, in each language suss reads.
 *
 * The three fixtures write the same services. `BaseService.call` makes
 * one of whichever class it was called on and calls `call` or `run` on
 * it, and each subclass writes its own. A route that calls
 * `CreateService.call` reaches the subclass's write, and the base
 * method's own summary still says what it does on the base class.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extract } from "./extract.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const fixtures = path.resolve(__dirname, "../../../fixtures");

let out: string;

beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "suss-inherited-receiver-"));
});

afterEach(() => {
  fs.rmSync(out, { recursive: true, force: true });
});

async function summariesOf(
  fixture: string,
  options: { lang?: "python" | "ruby"; frameworks: string[] },
): Promise<BehavioralSummary[]> {
  const dir = path.join(fixtures, fixture);
  return await extract({
    dir,
    ...(options.lang === undefined ? {} : { lang: options.lang }),
    frameworks: options.frameworks.map((spec) =>
      spec.replace("=", `=${dir}${path.sep}`),
    ),
    output: path.join(out, "summaries.json"),
    noCache: true,
    quiet: true,
  });
}

const typescript = () =>
  summariesOf("inherited-receiver", { frameworks: ["express", "fetch"] });

const python = () =>
  summariesOf("inherited-receiver-python", {
    lang: "python",
    frameworks: ["fastapi", "sqlmodel=suss.sqlmodel.json"],
  });

const ruby = () =>
  summariesOf("inherited-receiver-ruby", {
    lang: "ruby",
    frameworks: [
      "rails=suss.rails.json",
      "activerecord=suss.activerecord.json",
    ],
  });

function invocations(summary: BehavioralSummary): Effect[] {
  return summary.transitions.flatMap((transition) =>
    transition.effects.filter((effect) => effect.type === "invocation"),
  );
}

/** The summary each call written as `callee` in a unit links to. */
function linkOf(
  summaries: readonly BehavioralSummary[],
  unit: string,
  callee: string,
): BehavioralSummary | undefined {
  const caller = summaries.find((summary) => summary.identity.id === unit);
  const effect = caller === undefined ? [] : invocations(caller);
  const linked = effect.find(
    (one) => one.type === "invocation" && one.callee === callee,
  );
  const id = linked?.type === "invocation" ? linked.summary : undefined;
  return summaries.find((summary) => summary.identity.id === id);
}

/** Every storage container a unit writes through the calls it is certain to make. */
function tablesWrittenFrom(
  summaries: readonly BehavioralSummary[],
  unit: string,
): string[] {
  const byId = new Map(summaries.map((one) => [one.identity.id, one]));
  const seen = new Set<string>([unit]);
  const queue = [unit];
  const written = new Set<string>();
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const summary = byId.get(id);
    for (const effect of summary?.transitions.flatMap((t) => t.effects) ?? []) {
      if (
        effect.type === "interaction" &&
        effect.binding.semantics.name === "storage" &&
        effect.interaction.class === "storage-access" &&
        effect.interaction.kind === "write"
      ) {
        written.add(effect.binding.semantics.container ?? "?");
      }
      if (
        effect.type === "invocation" &&
        effect.summary !== undefined &&
        !seen.has(effect.summary)
      ) {
        seen.add(effect.summary);
        queue.push(effect.summary);
      }
    }
  }
  return [...written].sort();
}

describe("Ruby: a service's class method written on its base class", () => {
  it("runs `new(...).call` on the class the route called it on", async () => {
    const summaries = await ruby();
    const route =
      "app/controllers/invoices_controller.rb::InvoicesController.create";

    const onCreate = linkOf(summaries, route, "Invoices::CreateService.call");
    expect(onCreate?.receiverClass).toEqual({
      file: "app/services/invoices/create_service.rb",
      name: "Invoices::CreateService",
    });
    expect(onCreate?.location.file).toBe("app/services/base_service.rb");
    expect(
      linkOf(summaries, onCreate?.identity.id ?? "", "new(...).call")?.identity
        .id,
    ).toBe(
      "app/services/invoices/create_service.rb::Invoices::CreateService.call",
    );
    expect(tablesWrittenFrom(summaries, route)).toEqual(["Invoice"]);
  });

  it("follows a local made with `new`, `self.new`'s result, a bare call and `self.class`", async () => {
    const summaries = await ruby();
    const controller =
      "app/controllers/invoices_controller.rb::InvoicesController";

    expect(tablesWrittenFrom(summaries, `${controller}.create_logged`)).toEqual(
      ["Invoice"],
    );
    expect(tablesWrittenFrom(summaries, `${controller}.create_built`)).toEqual([
      "Invoice",
    ]);
    expect(tablesWrittenFrom(summaries, `${controller}.create_later`)).toEqual([
      "AuditEntry",
    ]);
    expect(tablesWrittenFrom(summaries, `${controller}.retry_void`)).toEqual([
      "Invoice",
    ]);
  });

  it("keeps the base class's own summary on the base class's methods", async () => {
    const summaries = await ruby();
    const own = summaries.find(
      (summary) =>
        summary.identity.id ===
        "app/services/base_service.rb::BaseService.call_with_log",
    );

    expect(own?.receiverClass).toBeUndefined();
    expect(
      linkOf(summaries, own?.identity.id ?? "", "call")?.location.file,
    ).toBe("app/services/base_service.rb");
    // A method that does the same thing on every subclass gets no summary per subclass.
    expect(
      summaries.filter(
        (summary) =>
          summary.identity.name === "log_start" ||
          summary.identity.name === "initialize",
      ),
    ).toHaveLength(2);
  });
});

describe("Python: a classmethod written on the base class", () => {
  it("runs `cls(...).run()` on the class the route called it on", async () => {
    const summaries = await python();

    const onCreate = linkOf(
      summaries,
      "app/main.py::create",
      "CreateInvoice.call",
    );
    expect(onCreate?.receiverClass).toEqual({
      file: "app/services.py",
      name: "CreateInvoice",
    });
    expect(
      linkOf(summaries, onCreate?.identity.id ?? "", "cls(**kwargs).run")
        ?.identity.id,
    ).toBe("app/services.py::CreateInvoice.run");
    expect(tablesWrittenFrom(summaries, "app/main.py::create")).toContain(
      "Invoice",
    );
    expect(tablesWrittenFrom(summaries, "app/main.py::void")).toContain(
      "Invoice",
    );
  });

  it("follows a local made with `cls`, a classmethod's result and `cls.perform`", async () => {
    const summaries = await python();

    expect(
      tablesWrittenFrom(summaries, "app/main.py::create_logged"),
    ).toContain("Invoice");
    expect(tablesWrittenFrom(summaries, "app/main.py::create_built")).toContain(
      "Invoice",
    );
    expect(tablesWrittenFrom(summaries, "app/main.py::create_later")).toContain(
      "AuditEntry",
    );
  });

  it("keeps the base class's own summary on the base class's methods", async () => {
    const summaries = await python();

    expect(
      linkOf(
        summaries,
        "app/services.py::BaseService.call",
        "cls(**kwargs).run",
      )?.identity.id,
    ).toBe("app/services.py::BaseService.run");
  });
});

describe("TypeScript: a static method written on the base class", () => {
  it("runs `new this(args).run()` on the class the route called it on", async () => {
    const summaries = await typescript();
    const route = summaries.find((summary) =>
      summary.identity.id?.endsWith("routes.ts::post#POST /invoices"),
    );

    const onCreate = linkOf(
      summaries,
      route?.identity.id ?? "",
      "CreateInvoice.call",
    );
    expect(onCreate?.receiverClass?.name).toBe("CreateInvoice");
    const run = linkOf(
      summaries,
      onCreate?.identity.id ?? "",
      "new this(args).run",
    );
    expect(run?.location.range.start).toBe(33);
    expect(
      linkOf(summaries, run?.identity.id ?? "", "db.insert")?.identity.name,
    ).toBe("insert");
  });

  it("follows a const made with `new this` and the `this.run` inside the method it calls", async () => {
    const summaries = await typescript();
    const route = summaries.find((summary) =>
      summary.identity.id?.endsWith("routes.ts::post#POST /invoices/logged"),
    );

    const onCreate = linkOf(
      summaries,
      route?.identity.id ?? "",
      "CreateInvoice.callLogged",
    );
    const runWithLog = linkOf(
      summaries,
      onCreate?.identity.id ?? "",
      "service.runWithLog",
    );
    expect(runWithLog?.receiverClass?.name).toBe("CreateInvoice");
    expect(
      linkOf(summaries, runWithLog?.identity.id ?? "", "this.run")?.location
        .range.start,
    ).toBe(33);
  });
});
