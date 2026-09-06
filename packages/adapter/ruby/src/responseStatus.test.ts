import { describe, expect, it } from "vitest";

import { controllerActionsPattern } from "./__fixtures__/railsControllerPattern.js";
import { field, instanceMethodsByName } from "./ast.js";
import { parseRuby } from "./parser.js";
import { responseBranches } from "./responseStatus.js";

import type { RawBranch, RawEffect, Reading } from "@suss/extractor";
import type { ControllerActions } from "./pack.js";

/** Rails' own response calls and the handful of Rack names these tests write. */
const RAILS_LIKE: Partial<ControllerActions> = {
  responseStatusCalls: [
    { name: "render", statusKeyword: "status" },
    { name: "head", statusArgument: 0, statusKeyword: "status" },
    { name: "redirect_to", statusKeyword: "status", defaultStatusCode: 302 },
  ],
  statusCodeNames: {
    ok: 200,
    created: 201,
    accepted: 202,
    no_content: 204,
    not_found: 404,
    unprocessable_entity: 422,
  },
};

async function actionMethod(actionBody: string) {
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
  return method;
}

async function branchesOf(
  actionBody: string,
  pattern: Partial<ControllerActions> = RAILS_LIKE,
  effects: RawEffect[] = [],
  extraEffects?: RawBranch["extraEffects"],
): Promise<RawBranch[]> {
  const method = await actionMethod(actionBody);
  const branches = responseBranches(
    method,
    controllerActionsPattern(pattern),
    effects,
    extraEffects,
  );
  if (branches === null) {
    throw new Error("the walk read no branches for this action");
  }
  return branches;
}

/** The reading each branch claims, which is what a summary collapses into a status. */
function readings(branches: readonly RawBranch[]): Array<Reading<number>> {
  return branches.map((branch) => {
    const reading = branch.statusCodeReading?.reading;
    if (reading === undefined) {
      throw new Error("a branch came back with no status reading");
    }
    return reading;
  });
}

/** Each branch's conditions written the way the summary shows them. */
function conditions(branches: readonly RawBranch[]): string[][] {
  return branches.map((branch) =>
    branch.conditions.map(
      (condition) =>
        `${condition.polarity === "negative" ? "!" : ""}${condition.sourceText}`,
    ),
  );
}

/** A single reading, for an action the walk gives exactly one branch. */
async function onlyReading(
  actionBody: string,
  pattern: Partial<ControllerActions> = RAILS_LIKE,
): Promise<Reading<number>> {
  const branches = await branchesOf(actionBody, pattern);
  expect(branches).toHaveLength(1);
  return readings(branches)[0] as Reading<number>;
}

describe("responseBranches, reading one response call", () => {
  it("reads a status written as one of the names the pack declares", async () => {
    expect(
      await onlyReading("    render json: item, status: :created"),
    ).toMatchObject({ kind: "written", value: 201 });
  });

  it("reads a status written as a number", async () => {
    expect(
      await onlyReading("    render json: item, status: 422"),
    ).toMatchObject({ kind: "written", value: 422 });
  });

  it("reads the status a call takes as its first argument", async () => {
    expect(await onlyReading("    head :no_content")).toMatchObject({
      kind: "written",
      value: 204,
    });
  });

  it("prefers the keyword over the positional argument when a call writes both", async () => {
    expect(await onlyReading("    head :ok, status: :created")).toMatchObject({
      kind: "written",
      value: 201,
    });
  });

  it("follows a status through a local name", async () => {
    expect(
      await onlyReading(
        "    code = :created\n    render json: item, status: code",
      ),
    ).toMatchObject({ kind: "written", value: 201 });
  });

  it("leaves the reading absent when the call writes no status of its own", async () => {
    expect(await onlyReading("    render json: item")).toEqual({
      kind: "absent",
    });
  });

  it("gives a call its own declared default when it writes no status", async () => {
    expect(await onlyReading('    redirect_to "/orders"')).toMatchObject({
      kind: "written",
      value: 302,
    });
  });

  it("reads the status a redirect writes over that redirect's own default", async () => {
    expect(
      await onlyReading('    redirect_to "/orders", status: :not_found'),
    ).toMatchObject({ kind: "written", value: 404 });
  });

  it("reports a status it cannot settle on a number rather than claiming one", async () => {
    expect(
      await onlyReading("    render json: item, status: params[:code]"),
    ).toMatchObject({ kind: "unreadable" });
  });

  it("reports a name the pack does not declare rather than claiming a number", async () => {
    expect(await onlyReading("    head :teapot")).toMatchObject({
      kind: "unreadable",
    });
  });

  it("reads nothing when the pack declares no response calls", async () => {
    const method = await actionMethod("    head :no_content");
    expect(
      responseBranches(method, controllerActionsPattern({}), [], undefined),
    ).toBeNull();
  });

  it("reads a bare render written with no arguments at all", async () => {
    expect(await onlyReading("    render")).toEqual({ kind: "absent" });
  });

  it("reads nothing out of a method the action defines inside itself", async () => {
    expect(
      await onlyReading(
        "    def fallback\n      return render(json: {}, status: :created)\n    end\n    head :ok",
      ),
    ).toMatchObject({ kind: "written", value: 200 });
  });

  it("reads no outcome at all from an action that only raises", async () => {
    const method = await actionMethod("    raise ArgumentError");
    expect(
      responseBranches(
        method,
        controllerActionsPattern(RAILS_LIKE),
        [],
        undefined,
      ),
    ).toBeNull();
  });
});

describe("responseBranches, one branch per path", () => {
  it("reports a status per arm when two branches each respond", async () => {
    const branches = await branchesOf(
      "    if item.save\n      render json: item, status: :created\n    else\n      render json: item.errors, status: :unprocessable_entity\n    end",
    );
    expect(readings(branches)).toMatchObject([
      { kind: "written", value: 201 },
      { kind: "written", value: 422 },
    ]);
    expect(conditions(branches)).toEqual([["item.save"], ["!item.save"]]);
    expect(branches.map((branch) => branch.isDefault)).toEqual([false, false]);
  });

  it("keeps one arm unreadable without touching the other", async () => {
    const branches = await branchesOf(
      "    if item.save\n      render json: item, status: params[:code]\n    else\n      render json: item.errors, status: :unprocessable_entity\n    end",
    );
    expect(readings(branches)).toMatchObject([
      { kind: "unreadable" },
      { kind: "written", value: 422 },
    ]);
  });

  it("ends the path at a response, so a render after one that already returned is not an outcome", async () => {
    const branches = await branchesOf(
      "    render json: item.errors, status: :unprocessable_entity and return\n    render json: item, status: :created",
    );
    expect(readings(branches)).toMatchObject([{ kind: "written", value: 422 }]);
  });

  it("reads a response the action returns, and the one left for everything else", async () => {
    const branches = await branchesOf(
      "    return render(json: {}, status: :not_found) if params[:id].blank?\n    render json: item, status: :ok",
    );
    expect(readings(branches)).toMatchObject([
      { kind: "written", value: 404 },
      { kind: "written", value: 200 },
    ]);
    expect(conditions(branches)).toEqual([
      ["params[:id].blank?"],
      ["!params[:id].blank?"],
    ]);
  });

  it("reads a response an if modifier gates", async () => {
    const branches = await branchesOf(
      "    render json: {}, status: :not_found if params[:id].blank?\n    render json: item, status: :ok",
    );
    expect(readings(branches)).toMatchObject([
      { kind: "written", value: 404 },
      { kind: "written", value: 200 },
    ]);
  });

  it("gives an action that responds once after doing work a single branch", async () => {
    const branches = await branchesOf(
      "    Order.destroy_all\n    head :no_content",
    );
    expect(readings(branches)).toMatchObject([{ kind: "written", value: 204 }]);
    expect(branches[0]?.conditions).toEqual([]);
    expect(branches[0]?.isDefault).toBe(true);
  });

  it("gives a path that ends in a bare return the implicit render", async () => {
    const branches = await branchesOf(
      "    return if params[:id].blank?\n    render json: item, status: :ok",
    );
    expect(readings(branches)).toMatchObject([
      { kind: "written", value: 200 },
      { kind: "absent" },
    ]);
    expect(conditions(branches)).toEqual([
      ["!params[:id].blank?"],
      ["params[:id].blank?"],
    ]);
  });

  it("gives a body that responds nowhere one branch with no reading", async () => {
    const branches = await branchesOf("    Order.create!(order_params)");
    expect(readings(branches)).toEqual([{ kind: "absent" }]);
    expect(branches[0]?.isDefault).toBe(true);
  });

  it("reads a format block per response, and the path where no format ran", async () => {
    const branches = await branchesOf(
      "    respond_to do |format|\n      format.json { render json: item, status: :ok }\n      format.html { render html: '', status: :accepted }\n    end",
    );
    expect(readings(branches)).toMatchObject([
      { kind: "written", value: 200 },
      { kind: "written", value: 202 },
      { kind: "absent" },
    ]);
    expect(conditions(branches)[0]).toEqual([
      "some iteration of: respond_to",
      "some iteration of: format.json",
    ]);
  });
});

describe("responseBranches, effects per branch", () => {
  const gated = (sourceText: string, polarity: "positive" | "negative") => ({
    type: "invocation" as const,
    callee: `work_${polarity}`,
    args: [],
    async: false,
    preconditions: [
      { sourceText, structured: null, polarity, source: "explicit" as const },
    ],
  });

  it("leaves a call off a branch whose conditions rule it out", async () => {
    const branches = await branchesOf(
      "    if item.save\n      render json: item, status: :created\n    else\n      render json: item.errors, status: :unprocessable_entity\n    end",
      RAILS_LIKE,
      [gated("item.save", "positive"), gated("item.save", "negative")],
    );
    expect(
      branches.map((branch) =>
        branch.effects.map((effect) =>
          effect.type === "invocation" ? effect.callee : effect.type,
        ),
      ),
    ).toEqual([["work_positive"], ["work_negative"]]);
  });

  it("puts the effects a recognizer built on every branch", async () => {
    const branches = await branchesOf(
      "    if item.save\n      head :created\n    else\n      head :no_content\n    end",
      RAILS_LIKE,
      [],
      [{ type: "stateChange", variable: "counter" }],
    );
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.extraEffects).toEqual([
        { type: "stateChange", variable: "counter" },
      ]);
    }
  });
});
