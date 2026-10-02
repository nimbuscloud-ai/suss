import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import railsFramework from "@suss/packs/rails";

import { relativizeSummaryPaths } from "./extract.js";
import { behaviorDiff } from "./inspect.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const ROUTES = `
Rails.application.routes.draw do
  resources :accounts, only: [:show]
end
`;

const APPLICATION = `
class ApplicationController < ActionController::Base
end
`;

interface Version {
  /** The class the action raises and the handler rescues. */
  closed: string;
  /** What the handler sends a JSON client. */
  gone: string;
  /** Whether the controller rescues the class at all. */
  rescued: boolean;
}

function controller({ closed, gone, rescued }: Version): string {
  const handler = rescued
    ? `
  rescue_from ${closed} do
    respond_to do |format|
      format.any { redirect_back fallback_location: root_path }
      format.json { head :${gone} }
    end
  end
`
    : "";
  return `
class AccountsController < ApplicationController
  before_action :find_account, only: %i(show)
${handler}
  def show
    render json: @account
  end

  private

  def find_account
    @account = Account.find_by(id: params[:id])
    raise ${closed} if @account.closed?
  end
end
`;
}

const ERRORS = `
module Billing
  class AccountClosed < StandardError
  end

  module Errors
    class AccountClosed < StandardError
    end
  end
end
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function summariesOf(version: Version): Promise<BehavioralSummary[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-caught-throw-"));
  dirs.push(dir);
  for (const [relative, source] of Object.entries({
    "config/routes.rb": ROUTES,
    "app/controllers/application_controller.rb": APPLICATION,
    "app/controllers/accounts_controller.rb": controller(version),
    "app/models/billing.rb": ERRORS,
  })) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const appRoot = path.join(dir, "app");
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(appRoot),
    packs: [
      railsFramework({
        root: appRoot,
        routesFile: path.join(dir, "config/routes.rb"),
      }),
    ],
    projectRoot: dir,
  });
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, dir);
  }
  return summaries;
}

const BEFORE: Version = {
  closed: "Billing::AccountClosed",
  gone: "gone",
  rescued: true,
};

/** The boundaries the diff's headline counts, and the units it lists by file. */
async function diffTo(after: Version) {
  const report = behaviorDiff(
    await summariesOf(BEFORE),
    await summariesOf(after),
  );
  return {
    boundaries: report.blocks.map((block) => block.boundary),
    units: report.moved.map((unit) => unit.name).sort(),
  };
}

describe("a change no client of the boundary sees", () => {
  it("leaves a rescued exception's new class out of the boundary and lists it by file", async () => {
    expect(
      await diffTo({ ...BEFORE, closed: "Billing::Errors::AccountClosed" }),
    ).toEqual({ boundaries: [], units: ["find_account", "show"] });
  });

  it("still counts a change to what the handler sends", async () => {
    const { boundaries } = await diffTo({ ...BEFORE, gone: "not_found" });
    expect(boundaries).toEqual(["GET /accounts/{id}"]);
  });

  it("still counts a new class on a throw nothing on the route catches", async () => {
    const before = await summariesOf({ ...BEFORE, rescued: false });
    const after = await summariesOf({
      ...BEFORE,
      closed: "Billing::Errors::AccountClosed",
      rescued: false,
    });
    expect(
      behaviorDiff(before, after).blocks.map((block) => block.boundary),
    ).toEqual(["GET /accounts/{id}"]);
  });
});
