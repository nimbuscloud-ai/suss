import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  controllerActionsPattern,
  railsTestPack,
} from "./__fixtures__/railsControllerPattern.js";
import { field, instanceMethodsByName } from "./ast.js";
import { extractRubyProject } from "./index.js";
import { parseRuby } from "./parser.js";
import { findRubyFiles } from "./project.js";
import { responseBranches } from "./responseStatus.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { Reading } from "@suss/extractor";
import type { ControllerActions } from "./pack.js";

const RENDERS_JSON: Partial<ControllerActions> = {
  responseStatusCalls: [
    {
      name: "render",
      statusKeyword: "status",
      bodyKeyword: "json",
      bodySerializers: ["to_json", "as_json"],
    },
    { name: "head", statusArgument: 0, statusKeyword: "status" },
  ],
  statusCodeNames: { unprocessable_entity: 422 },
};

async function bodyReadings(
  actionBody: string,
  pattern: Partial<ControllerActions> = RENDERS_JSON,
): Promise<Array<Reading<TypeShape> | undefined>> {
  const tree = await parseRuby(
    `class OrdersController < ApplicationController\n  def create\n${actionBody}\n  end\nend\n`,
  );
  const classNode = tree.rootNode.namedChildren[0];
  const method = instanceMethodsByName(
    field(classNode ?? tree.rootNode, "body") ?? tree.rootNode,
  ).get("create");
  if (method === undefined) {
    throw new Error("the test class defines no create method");
  }
  const branches =
    responseBranches(
      method,
      controllerActionsPattern(pattern),
      [],
      undefined,
    ) ?? [];
  return branches.map((branch) => branch.bodyShapeReading?.reading);
}

describe("bodyReadingOfCall", () => {
  it("reads the keys and literal values of a hash render json: sends", async () => {
    expect(
      await bodyReadings(
        "    render json: { success: false, status: 422, error: record.message }, status: 422",
      ),
    ).toMatchObject([
      {
        kind: "written",
        value: {
          type: "record",
          properties: {
            success: { type: "literal", value: false },
            status: { type: "literal", value: 422 },
            error: { type: "unknown" },
          },
        },
      },
    ]);
  });

  it("reads a hash on each path that sends one", async () => {
    const readings = await bodyReadings(
      [
        "    if blocked?",
        '      render json: { result: "blocked" }',
        "    else",
        "      render json: { error: message }, status: :unprocessable_entity",
        "    end",
      ].join("\n"),
    );
    expect(readings).toMatchObject([
      {
        value: {
          properties: { result: { type: "literal", value: "blocked" } },
        },
      },
      { value: { properties: { error: { type: "unknown" } } } },
    ]);
  });

  it("reads a hash through a local name and through to_json", async () => {
    expect(
      await bodyReadings(
        "    payload = { ok: true }\n    render json: payload",
      ),
    ).toMatchObject([
      { value: { type: "record", properties: { ok: { type: "literal" } } } },
    ]);
    expect(
      await bodyReadings("    render json: { ok: true }.to_json"),
    ).toMatchObject([
      { value: { type: "record", properties: { ok: { type: "literal" } } } },
    ]);
  });

  it("reads an array of hashes as an array", async () => {
    expect(
      await bodyReadings('    render json: [{ id: 1, name: "a" }]'),
    ).toMatchObject([
      {
        value: {
          type: "array",
          items: { type: "record", properties: { id: {}, name: {} } },
        },
      },
    ]);
  });

  it("leaves a body it cannot read as a hash unread rather than empty", async () => {
    for (const body of [
      "    render json: order",
      "    render json: order.to_json",
      "    render json: '{\"ok\":true}'",
      "    render json: { id: 1 }.as_json(only: [:id])",
      '    render plain: "ok"',
      "    render",
      "    head :no_content",
    ]) {
      expect(await bodyReadings(body), body).toMatchObject([
        { kind: "absent" },
      ]);
    }
  });

  it("reads no body from a call the pack gives no body keyword", async () => {
    expect(
      await bodyReadings("    render json: { ok: true }", {
        responseStatusCalls: [{ name: "render", statusKeyword: "status" }],
      }),
    ).toMatchObject([{ kind: "absent" }]);
  });
});

describe("bodyReadingOfCall over a project", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("reads a hash a project method builds, and leaves a serializer object unread", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-body-"));
    const controllers = path.join(dir, "app", "controllers");
    fs.mkdirSync(controllers, { recursive: true });
    fs.writeFileSync(
      path.join(controllers, "sessions_controller.rb"),
      [
        "class SessionsController < ApplicationController",
        "  def create",
        "    render json: { success: true, session: session_json(found) }",
        "  end",
        "",
        "  def show",
        "    render json: SessionSerializer.new(found)",
        "  end",
        "",
        "  private",
        "",
        "  def session_json(session)",
        "    { id: session.id, title: session.title }",
        "  end",
        "end",
        "",
        "class SessionSerializer",
        "  def initialize(session)",
        "    @session = session",
        "    { id: session.id }",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    const result = await extractRubyProject({
      files: findRubyFiles(dir),
      packs: [
        railsTestPack({
          ...RENDERS_JSON,
          root: controllers,
          routesFor: (_controller, action) => [
            { method: "POST", path: `/sessions/${action}` },
          ],
        }),
      ],
      projectRoot: dir,
      cacheDir: null,
    });
    const bodyOf = (name: string) =>
      result.summaries.find(
        (summary) =>
          summary.kind === "handler" && summary.identity.name === name,
      )?.transitions[0]?.output;

    expect(bodyOf("create")).toMatchObject({
      type: "response",
      body: {
        type: "record",
        properties: {
          success: { type: "literal", value: true },
          session: {
            type: "record",
            properties: { id: { type: "unknown" }, title: { type: "unknown" } },
          },
        },
      },
    });
    expect(bodyOf("show")).toMatchObject({ type: "response", body: null });
  });
});
