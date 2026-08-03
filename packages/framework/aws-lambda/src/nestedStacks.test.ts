// Discovery when the service is split across nested stacks: the pack
// walks up to the root template, and the handlers declared in the
// documents that template embeds are found too.

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clearTemplateCache } from "./index.js";
import { handlersForFile } from "./templateIndex.js";

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/aws-nested-stacks",
);

function handlersFor(rel: string): ReturnType<typeof handlersForFile> {
  clearTemplateCache();
  // The fixture names two children nothing here can open, on purpose.
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return handlersForFile(path.join(fixturesDir, rel));
  } finally {
    stderr.mockRestore();
  }
}

afterEach(() => {
  clearTemplateCache();
  vi.restoreAllMocks();
});

describe("handlers declared in a nested stack", () => {
  it("finds a handler the root template only embeds", () => {
    const orders = handlersFor("src/orders/handler.ts");

    expect(orders).toHaveLength(1);
    expect(orders[0].functionLogicalId).toBe("OrdersStack/HandlerFunction");
    expect(orders[0].nonHttpEvents.map((e) => e.eventType)).toEqual(["SQS"]);
  });

  it("keeps two children's same-named functions apart", () => {
    const billing = handlersFor("src/billing/handler.ts");

    expect(billing[0].functionLogicalId).toBe("BillingStack/HandlerFunction");
    expect(billing[0].httpRoutes.map((r) => r.path)).toEqual(["/invoices"]);
  });

  it("leaves a root resource its bare logical id", () => {
    expect(handlersFor("src/root/handler.ts")[0].functionLogicalId).toBe(
      "RootFunction",
    );
  });

  it("names the children it could not open", () => {
    clearTemplateCache();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    handlersForFile(path.join(fixturesDir, "src/root/handler.ts"));
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");

    expect(written).toContain("PackagedStack");
    expect(written).toContain("DashboardStack");
  });
});
