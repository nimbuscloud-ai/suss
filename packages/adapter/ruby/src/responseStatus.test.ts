import { describe, expect, it } from "vitest";

import { controllerActionsPattern } from "./__fixtures__/railsControllerPattern.js";
import { field, instanceMethodsByName } from "./ast.js";
import { parseRuby } from "./parser.js";
import { responseStatusReading } from "./responseStatus.js";

import type { ControllerActions } from "./pack.js";

/** Rails' own two response calls and the handful of Rack names these tests write. */
const RAILS_LIKE: Partial<ControllerActions> = {
  responseStatusCalls: [
    { name: "render", statusKeyword: "status" },
    { name: "head", statusArgument: 0, statusKeyword: "status" },
  ],
  statusCodeNames: { ok: 200, created: 201, no_content: 204, not_found: 404 },
};

async function readStatus(
  actionBody: string,
  pattern: Partial<ControllerActions> = RAILS_LIKE,
) {
  const tree = await parseRuby(
    `class OrdersController < ApplicationController\n  def create\n${actionBody}\n  end\nend\n`,
  );
  const classNode = tree.rootNode.namedChildren[0];
  if (classNode === null || classNode === undefined) {
    throw new Error("the test source did not parse into a class");
  }
  const body = field(classNode, "body");
  if (body === null) {
    throw new Error("the test class parsed with no body");
  }
  const method = instanceMethodsByName(body).get("create");
  if (method === undefined) {
    throw new Error("the test class defines no create method");
  }
  return responseStatusReading(method, controllerActionsPattern(pattern));
}

describe("responseStatusReading", () => {
  it("reads a status written as one of the names the pack declares", async () => {
    const reading = await readStatus("    render json: item, status: :created");
    expect(reading).toMatchObject({ kind: "written", value: 201 });
  });

  it("reads a status written as a number", async () => {
    const reading = await readStatus("    render json: item, status: 422");
    expect(reading).toMatchObject({ kind: "written", value: 422 });
  });

  it("reads the status a call takes as its first argument", async () => {
    const reading = await readStatus("    head :no_content");
    expect(reading).toMatchObject({ kind: "written", value: 204 });
  });

  it("prefers the keyword over the positional argument when a call writes both", async () => {
    const reading = await readStatus("    head :ok, status: :created");
    expect(reading).toMatchObject({ kind: "written", value: 201 });
  });

  it("follows a status through a local name", async () => {
    const reading = await readStatus(
      "    code = :created\n    render json: item, status: code",
    );
    expect(reading).toMatchObject({ kind: "written", value: 201 });
  });

  it("leaves the reading absent when the action writes no status", async () => {
    const reading = await readStatus("    render json: item");
    expect(reading).toEqual({ kind: "absent" });
  });

  it("leaves the reading absent when the action writes no response call at all", async () => {
    const reading = await readStatus("    Order.create!(order_params)");
    expect(reading).toEqual({ kind: "absent" });
  });

  it("reads a status written inside a branch", async () => {
    const reading = await readStatus(
      "    if item.save\n      head :created\n    end",
    );
    expect(reading).toMatchObject({ kind: "written", value: 201 });
  });

  it("keeps both candidates when two branches write different statuses", async () => {
    const reading = await readStatus(
      "    if item.save\n      render json: item, status: :created\n    else\n      render json: item.errors, status: :not_found\n    end",
    );
    expect(reading).toMatchObject({ kind: "ambiguous" });
    if (reading.kind === "ambiguous") {
      expect([...reading.candidates].sort()).toEqual([201, 404]);
    }
  });

  it("counts the library default as a candidate when one branch writes no status", async () => {
    const reading = await readStatus(
      "    if item.save\n      render json: item, status: :created\n    else\n      render json: item.errors\n    end",
    );
    expect(reading).toMatchObject({ kind: "ambiguous" });
    if (reading.kind === "ambiguous") {
      expect([...reading.candidates].sort()).toEqual([200, 201]);
    }
  });

  it("claims the one status two calls agree on", async () => {
    const reading = await readStatus(
      "    if item.save\n      render json: item, status: :ok\n    else\n      render json: item.errors\n    end",
    );
    expect(reading).toMatchObject({ kind: "written", value: 200 });
  });

  it("reports a status it cannot settle on a number rather than claiming one", async () => {
    const reading = await readStatus(
      "    render json: item, status: params[:code]",
    );
    expect(reading).toMatchObject({ kind: "unreadable" });
  });

  it("reports a name the pack does not declare rather than claiming a number", async () => {
    const reading = await readStatus("    head :teapot");
    expect(reading).toMatchObject({ kind: "unreadable" });
  });

  it("reads nothing when the pack declares no response calls", async () => {
    const reading = await readStatus("    head :no_content", {});
    expect(reading).toEqual({ kind: "absent" });
  });
});
