import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConstantFileCache } from "./constantPath.js";
import { ExceptionReader } from "./exceptionClasses.js";
import { parseRuby } from "./parser.js";

import type { AncestorLookup } from "./ancestry.js";
import type { RbNode } from "./parser.js";

let appRoot: string;

beforeEach(() => {
  appRoot = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-exceptions-")),
    "app",
  );
});

afterEach(() => {
  fs.rmSync(path.dirname(appRoot), { recursive: true, force: true });
});

function write(relative: string, source: string): void {
  const file = path.join(appRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function reader(): ExceptionReader {
  const lookup: AncestorLookup = {
    root: appRoot,
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: ["ActionController::Base"],
    constantFiles: createConstantFileCache(),
    parsedFile: async (file) =>
      (await parseRuby(fs.readFileSync(file, "utf8")))
        .rootNode as unknown as RbNode,
  };
  return new ExceptionReader(lookup, {
    "Store::RecordNotFound": {
      status: 404,
      ancestors: ["Store::StoreError", "StandardError", "Exception"],
    },
  });
}

const read = (candidates: string[]) =>
  reader().read({ text: candidates.at(-1) ?? "", candidates });

describe("what an exception class inherits from", () => {
  it("lists Ruby's own exception classes up to Exception", async () => {
    expect(await read(["KeyError"])).toEqual({
      name: "KeyError",
      ancestors: ["IndexError", "StandardError", "Exception"],
      incomplete: false,
      inheritableByUnread: true,
    });
  });

  it("takes a library's class and its ancestry from the pack", async () => {
    expect(await read(["Store::RecordNotFound"])).toMatchObject({
      ancestors: ["Store::StoreError", "StandardError", "Exception"],
      incomplete: false,
      inheritableByUnread: false,
    });
  });

  it("walks a project class to the Ruby class it inherits from", async () => {
    write("errors/plan_exceeded.rb", "class PlanExceeded < QuotaError; end\n");
    write("errors/quota_error.rb", "class QuotaError < RuntimeError; end\n");
    expect(await read(["PlanExceeded"])).toEqual({
      name: "PlanExceeded",
      ancestors: ["QuotaError", "RuntimeError", "StandardError", "Exception"],
      incomplete: false,
      inheritableByUnread: false,
    });
  });

  it("finds a class nested in its namespace's own file", async () => {
    write(
      "models/billing.rb",
      "module Billing\n  class LimitReached < StandardError; end\nend\n",
    );
    expect(await read(["Billing::LimitReached"])).toMatchObject({
      name: "Billing::LimitReached",
      ancestors: ["StandardError", "Exception"],
      incomplete: false,
    });
  });

  it("marks a project class whose ancestry reaches a class the run did not read", async () => {
    write(
      "errors/upstream_failed.rb",
      "class UpstreamFailed < HttpClient::Error; end\n",
    );
    expect(await read(["UpstreamFailed"])).toEqual({
      name: "UpstreamFailed",
      ancestors: ["HttpClient::Error", "Exception"],
      incomplete: true,
      inheritableByUnread: false,
    });
  });

  it("knows only that a class the run did not read is an Exception", async () => {
    expect(await read(["Api::AccessDenied", "AccessDenied"])).toEqual({
      name: "AccessDenied",
      ancestors: ["Exception"],
      incomplete: true,
      inheritableByUnread: true,
    });
  });

  it("takes the project's class in the enclosing namespace over Ruby's own of the same name", async () => {
    write(
      "errors/api/argument_error.rb",
      "module Api\n  class ArgumentError < StandardError; end\nend\n",
    );
    expect(await read(["Api::ArgumentError", "ArgumentError"])).toMatchObject({
      name: "Api::ArgumentError",
      ancestors: ["StandardError", "Exception"],
    });
  });
});
