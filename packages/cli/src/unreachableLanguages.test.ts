/**
 * A route that tests whether a helper found an order, extracted while the
 * helper can still return nothing and after it always returns an object.
 * In TypeScript and Ruby every object is true, so once the helper always
 * returns one the route can no longer respond 404. Python counts an empty
 * dict as false, so a helper that may return `{}` leaves the 404 in reach.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { preloadRubyGrammar } from "@suss/adapter-ruby";

import { runCli } from "./run.js";
import { readSummaries } from "./summaryFile.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

let root: string;
let projects = 0;

beforeAll(async () => {
  await preloadRubyGrammar();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-unreachable-")),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Run the CLI and keep what it printed. */
async function captured(
  argv: string[],
): Promise<{ code: number; out: string }> {
  const written: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await runCli(argv), out: written.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/**
 * Write a project, extract it, and give back the summaries file. `args`
 * gets the project's directory, for a pack config written inside it.
 */
async function extracted(
  files: Readonly<Record<string, string>>,
  args: (dir: string) => readonly string[],
): Promise<string> {
  projects += 1;
  const dir = path.join(root, `project-${projects}`);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const out = path.join(root, `summaries-${projects}.json`);
  const { code } = await captured([
    "extract",
    "--dir",
    dir,
    ...args(dir),
    "--no-cache",
    "-o",
    out,
  ]);
  expect(code).toBe(0);
  return out;
}

/** The transitions of the unit serving the route, by status. */
function byStatus(file: string): Map<number, Transition> {
  const summaries: BehavioralSummary[] = readSummaries(file);
  const route = summaries.find(
    (summary) =>
      summary.identity.boundaryBinding?.semantics.name === "rest" &&
      summary.transitions.some(
        (transition) =>
          transition.output.type === "response" &&
          transition.output.statusCode?.type === "literal" &&
          transition.output.statusCode.value === 404,
      ),
  );
  expect(route).toBeDefined();
  const found = new Map<number, Transition>();
  for (const transition of route?.transitions ?? []) {
    const status =
      transition.output.type === "response" &&
      transition.output.statusCode?.type === "literal"
        ? transition.output.statusCode.value
        : null;
    if (typeof status === "number") {
      found.set(status, transition);
    }
  }
  return found;
}

const TYPESCRIPT_ROUTE = (helper: string, guard = "!order") => `
import express from "express";

const app = express();
const db: any = {};

interface Order {
  id: string;
  total: number;
}

function toOrder(row: { id: string; total: number }): Order {
  return { id: row.id, total: row.total };
}

${helper}

app.get("/orders/:id", async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (${guard}) {
    return res.status(404).json({ error: "order not found" });
  }
  return res.json(order);
});

export default app;
`;

const TYPESCRIPT_FINDS = (missing: string) => `
async function loadOrder(id: string): Promise<Order> {
  const row = await db.order.findUnique({ where: { id } });
  return row ? toOrder(row) : (${missing} as Order);
}
`;

async function typescript(helper: string, guard?: string): Promise<string> {
  return await extracted(
    {
      "src/orders.ts": TYPESCRIPT_ROUTE(helper, guard),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ["src/**/*.ts"],
      }),
    },
    () => ["-f", "express"],
  );
}

const PYTHON_ROUTE = (missing: string, guard = "not order") => `
from fastapi import FastAPI, HTTPException

app = FastAPI()


def to_order(row):
    return {"id": row.id, "total": row.total}


def load_order(order_id):
    row = db.get(order_id)
    return to_order(row) if row else ${missing}


@app.get("/orders/{order_id}")
def get_order(order_id: str):
    order = load_order(order_id)
    if ${guard}:
        raise HTTPException(status_code=404, detail="order not found")
    return order
`;

async function python(missing: string, guard?: string): Promise<string> {
  return await extracted(
    { "app/main.py": PYTHON_ROUTE(missing, guard) },
    () => ["--lang", "python", "-f", "fastapi"],
  );
}

const RUBY_CONTROLLER = (missing: string, guard = "!order") => `
class OrdersController < ApplicationController
  def show
    order = load_order(params[:id])
    if ${guard}
      head :not_found
      return
    end
    render json: order
  end

  private

  def to_order(row)
    { id: row.id, total: row.total }
  end

  def load_order(id)
    row = Order.find_by(id: id)
    row ? to_order(row) : ${missing}
  end
end
`;

async function ruby(missing: string, guard?: string): Promise<string> {
  const files = {
    "config/routes.rb":
      "Rails.application.routes.draw do\n  resources :orders, only: [:show]\nend\n",
    "app/controllers/application_controller.rb":
      "class ApplicationController < ActionController::Base\nend\n",
    "app/controllers/orders_controller.rb": RUBY_CONTROLLER(missing, guard),
    "suss.rails.json": JSON.stringify({
      root: "app",
      routesFile: "config/routes.rb",
    }),
  };
  return await extracted(files, (dir) => [
    "--lang",
    "ruby",
    "-f",
    `rails=${path.join(dir, "suss.rails.json")}`,
  ]);
}

describe("a route whose helper always returns an object", () => {
  it("says in TypeScript that the 404 can no longer happen, and why", async () => {
    const before = await typescript(TYPESCRIPT_FINDS("null"));
    const after = await typescript(TYPESCRIPT_FINDS("{}"));

    expect(byStatus(before).get(404)?.unreachable).toBeUndefined();
    expect(byStatus(after).get(404)?.unreachable).toMatchObject({
      condition: 0,
      every: "truthy",
      values: { type: "record" },
    });
    expect(byStatus(after).get(200)?.unreachable).toBeUndefined();

    const diff = await captured(["inspect", "--diff", before, after]);
    expect(diff.out).toContain(
      "can no longer happen: loadOrder() is always an object, which is truthy",
    );
    const json = await captured(["inspect", "--diff", before, after, "--json"]);
    const outcomes = (
      JSON.parse(json.out) as {
        boundaries: { outcomes: { cannotHappen?: string }[] }[];
      }
    ).boundaries.flatMap((boundary) => boundary.outcomes);
    expect(outcomes.map((outcome) => outcome.cannotHappen)).toContain(
      "loadOrder() is always an object, which is truthy",
    );
  }, 60_000);

  it("says the same in Python for a dict that always has a key", async () => {
    const before = await python("None");
    const after = await python('{"id": order_id}');

    expect(byStatus(before).get(404)?.unreachable).toBeUndefined();
    expect(byStatus(after).get(404)?.unreachable).toMatchObject({
      every: "truthy",
    });
    expect(byStatus(after).get(200)?.unreachable).toBeUndefined();
  }, 60_000);

  it("says the same in Ruby for a hash", async () => {
    const before = await ruby("nil");
    const after = await ruby("{}");

    expect(byStatus(before).get(404)?.unreachable).toBeUndefined();
    expect(byStatus(after).get(404)?.unreachable).toMatchObject({
      every: "truthy",
    });
    expect(byStatus(after).get(200)?.unreachable).toBeUndefined();
  }, 60_000);
});

describe("a route whose 404 is still in reach", () => {
  it("leaves it alone in Python when the helper may return an empty dict", async () => {
    const routes = byStatus(await python("{}"));
    expect(routes.get(404)?.unreachable).toBeUndefined();
    expect(routes.get(200)?.unreachable).toBeUndefined();
  }, 60_000);

  it("leaves it alone in Ruby when the helper may return false", async () => {
    const routes = byStatus(await ruby("false"));
    expect(routes.get(404)?.unreachable).toBeUndefined();
    expect(routes.get(200)?.unreachable).toBeUndefined();
  }, 60_000);

  it("leaves it alone when one value the helper returns is one suss cannot read", async () => {
    const helper = TYPESCRIPT_FINDS("lookup(id)");
    expect(
      byStatus(await typescript(helper)).get(404)?.unreachable,
    ).toBeUndefined();
    expect(
      byStatus(await python("lookup(order_id)")).get(404)?.unreachable,
    ).toBeUndefined();
    expect(
      byStatus(await ruby("Order.new")).get(404)?.unreachable,
    ).toBeUndefined();
  }, 60_000);

  it("leaves a condition on a parameter alone", async () => {
    const helper = TYPESCRIPT_FINDS("{}");
    expect(
      byStatus(await typescript(helper, "!req.params.id")).get(404)
        ?.unreachable,
    ).toBeUndefined();
    expect(
      byStatus(await python('{"id": order_id}', "not order_id")).get(404)
        ?.unreachable,
    ).toBeUndefined();
    expect(
      byStatus(await ruby("{}", "!params[:id]")).get(404)?.unreachable,
    ).toBeUndefined();
  }, 60_000);
});
