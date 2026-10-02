import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { readWrapperMetadata } from "@suss/behavioral-ir";
import { withActiveRecord } from "@suss/framework-activerecord";

import { railsFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const ROUTES = `
Rails.application.routes.draw do
  resources :accounts, only: [:show]
  resources :reports, only: [:show]
  resources :notes, only: [:show]
  namespace :api do
    resources :posts, only: [:show]
  end
end
`;

const SOURCES: Record<string, string> = {
  "app/models/application_record.rb": `
class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
`,
  "app/models/account.rb": `
class Account < ApplicationRecord
end
`,
  "app/controllers/application_controller.rb": `
class ApplicationController < ActionController::Base
  before_action :load_account

  private

  def load_account
    @account = Account.find(params[:account_id])
  end
end
`,
  "app/controllers/accounts_controller.rb": `
class AccountsController < ApplicationController
  def show
    render json: @account
  end
end
`,
  "app/controllers/api/posts_controller.rb": `
module Api
  class PostsController < ApplicationController
    rescue_from ActiveRecord::RecordNotFound, with: :gone

    def show
      render json: @account
    end

    private

    def gone
      head :gone
    end
  end
end
`,
  "app/controllers/reports_controller.rb": `
class ReportsController < ApplicationController
  skip_before_action :load_account
  rescue_from(*NETWORK_ERRORS, with: :unavailable)

  def show
    render json: Account.find(params[:id])
  end

  private

  def unavailable
    head :service_unavailable
  end
end
`,
  "app/controllers/notes_controller.rb": `
class NotesController < ApplicationController
  class Missing < StandardError; end
  class BadRequest < StandardError; end

  skip_before_action :load_account
  rescue_from Missing, with: :render_error
  rescue_from StandardError, with: :oops
  rescue_from BadRequest, with: :render_error

  def show
    raise Missing if missing?
    head :ok
  end

  private

  def render_error
    head :not_found
  end

  def oops
    head :internal_server_error
  end
end
`,
};

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** The project's summaries, with its files read in the order `order` puts them. */
async function extract(
  order: (files: string[]) => string[] = (files) => files,
): Promise<BehavioralSummary[]> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-rescue-"));
  for (const [relative, source] of Object.entries({
    "config/routes.rb": ROUTES,
    ...SOURCES,
  })) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const appRoot = path.join(dir, "app");
  const pack = withActiveRecord(
    railsFramework({
      root: appRoot,
      routesFile: path.join(dir, "config/routes.rb"),
    }),
    { storageSystem: "postgresql" },
  );
  const { summaries } = await extractRubyProject({
    files: order(findRubyFiles(appRoot).sort()),
    packs: [pack],
    workspaceRoot: dir,
  });
  return summaries;
}

/** Each outcome of one controller's `show` as its status or kind, beside the wrapper that added it and whether that wrapper only may catch. */
function outcomesOfShow(
  summaries: readonly BehavioralSummary[],
  controller: string,
): Array<[unknown, string | null, boolean]> {
  const show = summaries.find(
    (summary) =>
      summary.kind === "handler" &&
      summary.identity.exportPath?.join(".") === `${controller}.show`,
  );
  expect(show, controller).toBeDefined();
  return (show?.transitions ?? []).map((transition) => {
    const { output } = transition;
    const wrapper = readWrapperMetadata(transition);
    return [
      output.type === "response" && output.statusCode?.type === "literal"
        ? output.statusCode.value
        : output.type,
      wrapper?.from?.name ?? null,
      wrapper?.catchUncertain === true,
    ];
  });
}

describe("rescue_from composed onto each route", () => {
  it("gives an inherited filter's raise each controller's own handler, whichever controller is read first", async () => {
    for (const order of [
      (files: string[]) => files,
      (files: string[]) => [...files].reverse(),
    ]) {
      const summaries = await extract(order);
      expect(outcomesOfShow(summaries, "Api::PostsController")).toEqual([
        ["throw", "load_account", false],
        [200, null, false],
        [410, "gone", false],
      ]);
      expect(outcomesOfShow(summaries, "AccountsController")).toEqual([
        [404, "load_account", false],
        [200, null, false],
      ]);
    }
  });

  it("keeps Rails' own 404 beside a handler that only may catch the raise", async () => {
    const summaries = await extract();
    expect(outcomesOfShow(summaries, "ReportsController")).toEqual([
      [200, null, false],
      ["throw", null, false],
      [404, null, false],
      [503, "unavailable", true],
    ]);
  });
});
