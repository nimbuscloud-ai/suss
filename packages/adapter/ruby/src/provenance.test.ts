// Where a Rails action's values came from, over a whole project run: the
// columns its queries pick rows by and write, and the subjects of its
// guards, written as the value references a TypeScript route gets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { railsTestPack } from "./__fixtures__/railsControllerPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type {
  BehavioralSummary,
  ProvenanceEntry,
  ValueRef,
} from "@suss/behavioral-ir";
import type { RubyPack } from "./pack.js";

const storagePack: RubyPack = {
  name: "activerecord",
  protocol: "postgresql",
  discovery: [],
  storage: [
    {
      baseClasses: ["ApplicationRecord"],
      writes: ["create", "update"],
      reads: ["where", "find_by"],
      givesBack: ["where", "find_by"],
      storageSystem: "postgresql",
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-sources-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join("\n"));
}

async function actionNamed(name: string): Promise<BehavioralSummary> {
  const rails = {
    ...railsTestPack({
      root: path.join(tmpDir, "app", "controllers"),
      routeFor: (_controller, action) => ({
        method: "GET",
        path: `/orders/${action}`,
      }),
      responseStatusCalls: [{ name: "head", statusArgument: 0 }],
      statusCodeNames: { unauthorized: 401 },
    }),
    requestAccessors: ["params", "request"],
  };
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(tmpDir),
    packs: [rails, storagePack],
    projectRoot: tmpDir,
    cacheDir: null,
  });
  const found = summaries.find((summary) => summary.identity.name === name);
  if (found === undefined) {
    throw new Error(`no unit ${name}`);
  }
  return found;
}

/** Each slot as `slot name`, with its sources, across the unit's transitions. */
function sourcesIn(unit: BehavioralSummary): Record<string, ValueRef[]> {
  const found: Record<string, ValueRef[]> = {};
  for (const entry of unit.transitions.flatMap(
    (transition): ProvenanceEntry[] => transition.provenance ?? [],
  )) {
    found[`${entry.at.slot} ${entry.at.name}`] = entry.from;
  }
  return found;
}

describe("where a Rails action's values came from", () => {
  beforeEach(() => {
    write("app/models/application_record.rb", [
      "class ApplicationRecord",
      "end",
      "",
    ]);
    write("app/models/order.rb", [
      "class Order < ApplicationRecord",
      "end",
      "",
    ]);
  });

  it("reads params and a request header as the request, and a literal as itself", async () => {
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      '    tenant = request.headers["X-Tenant-Id"]',
      "    Order.where(tenant_id: tenant, status: params[:status])",
      "  end",
      "",
      "  def create",
      '    Order.create(reference: params[:reference], state: "new")',
      "  end",
      "end",
      "",
    ]);

    expect(sourcesIn(await actionNamed("index"))).toEqual({
      "selector status": [
        { type: "input", inputRef: "params", path: ["status"] },
      ],
      "selector tenant_id": [
        {
          type: "input",
          inputRef: "request",
          path: ["headers", "X-Tenant-Id"],
        },
      ],
    });
    expect(sourcesIn(await actionNamed("create"))).toEqual({
      "field reference": [
        { type: "input", inputRef: "params", path: ["reference"] },
      ],
      "field state": [{ type: "literal", value: "new" }],
    });
  });

  it("writes a guard on params as a read of the request", async () => {
    write("app/controllers/orders_controller.rb", [
      "class OrdersController < ApplicationController",
      "  def index",
      "    unless params[:tenant_id]",
      "      head :unauthorized",
      "      return",
      "    end",
      "    Order.where(tenant_id: params[:tenant_id])",
      "  end",
      "end",
      "",
    ]);

    const action = await actionNamed("index");
    expect(action.transitions.flatMap((t) => t.conditions)[0]).toEqual({
      type: "negation",
      operand: {
        type: "truthinessCheck",
        subject: { type: "input", inputRef: "params", path: ["tenant_id"] },
        negated: false,
      },
    });
  });
});
