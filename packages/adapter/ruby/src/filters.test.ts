import { describe, expect, it } from "vitest";

import { controllerActionsPattern } from "./__fixtures__/railsControllerPattern.js";
import { ancestryOf } from "./ancestry.js";
import {
  controllerFilters,
  filterCoversAction,
  filterUnit,
} from "./filters.js";
import { parseRuby } from "./parser.js";
import { walkDefinitions } from "./scope.js";

import type { Ancestry, ReachedBody } from "./ancestry.js";
import type { ControllerActions } from "./pack.js";
import type { RbNode } from "./parser.js";

/** Rails' own filter vocabulary, the same values the pack supplies. */
const RAILS_LIKE: Partial<ControllerActions> = {
  filters: [
    {
      name: "before_action",
      methodFrom: "argument",
      skippedBy: "skip_before_action",
      actionKeywords: { include: "only", exclude: "except" },
    },
    { name: "rescue_from", methodFrom: "withKeyword", onThrow: true },
  ],
  responseStatusCalls: [
    { name: "render", statusKeyword: "status" },
    { name: "head", statusArgument: 0, statusKeyword: "status" },
  ],
  statusCodeNames: { unauthorized: 401, not_found: 404 },
};

/** The ancestry of the one class the source defines, read without touching the disk. */
async function ancestryOfSource(source: string): Promise<Ancestry> {
  const tree = await parseRuby(source);
  const blocks: ReachedBody[] = [];
  const knownClasses = new Set<string>();
  walkDefinitions(tree.rootNode as unknown as RbNode, (info) => {
    knownClasses.add(info.qualifiedName);
    blocks.push({ info, knownClasses, file: "/app/controllers/orders.rb" });
  });
  const self = blocks.filter(
    (block) => block.info.qualifiedName === "OrdersController",
  );
  return ancestryOf("OrdersController", self, {
    root: "/app/controllers",
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: ["ActionController::Base"],
    parsedFile: async () => null,
    localDefinition: (name) =>
      blocks.filter((block) => block.info.qualifiedName === name),
  });
}

async function filtersOf(
  source: string,
  overrides: Partial<ControllerActions> = {},
) {
  return controllerFilters(
    controllerActionsPattern({ ...RAILS_LIKE, ...overrides }),
    await ancestryOfSource(source),
  );
}

describe("the filters a controller declares", () => {
  it("resolves the method a before_action names", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :require_login

  def show
  end

  private

  def require_login
    head :unauthorized
  end
end
`);

    expect(filters).toHaveLength(1);
    expect(filters[0]?.methodName).toBe("require_login");
    expect(filterCoversAction(filters[0] as never, "show")).toBe(true);
  });

  it("covers only the actions an only: keyword names", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :load_order, only: %i[show cancel]

  def load_order
  end
end
`);

    const filter = filters[0] as never;
    expect(filterCoversAction(filter, "show")).toBe(true);
    expect(filterCoversAction(filter, "cancel")).toBe(true);
    expect(filterCoversAction(filter, "index")).toBe(false);
  });

  it("leaves out the actions an except: keyword names", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :require_login, except: [:index]

  def require_login
  end
end
`);

    expect(filterCoversAction(filters[0] as never, "index")).toBe(false);
    expect(filterCoversAction(filters[0] as never, "show")).toBe(true);
  });

  it("takes a filter off the actions a skip names, and leaves the rest", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :require_login
  skip_before_action :require_login, only: [:index]

  def require_login
  end
end
`);

    expect(filterCoversAction(filters[0] as never, "index")).toBe(false);
    expect(filterCoversAction(filters[0] as never, "show")).toBe(true);
  });

  it("takes a filter off altogether when the skip names no actions", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :require_login
  skip_before_action :require_login

  def require_login
  end
end
`);

    expect(filters).toEqual([]);
  });

  it("names both methods a before_action lists", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :require_login, :load_order

  def require_login
  end

  def load_order
  end
end
`);

    expect(filters.map((one) => one.methodName)).toEqual([
      "require_login",
      "load_order",
    ]);
  });

  it("reads the handler a rescue_from names under with:, and runs it last", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  rescue_from ActiveRecord::RecordNotFound, with: :not_found
  before_action :require_login

  def require_login
  end

  def not_found(error)
  end
end
`);

    expect(filters.map((one) => one.methodName)).toEqual([
      "require_login",
      "not_found",
    ]);
    expect(filters[1]?.filter.onThrow).toBe(true);
  });

  it("says nothing about a filter whose method this run cannot see", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :from_a_gem

  def show
  end
end
`);

    expect(filters).toEqual([]);
  });
});

describe("the unit a filter method gets", () => {
  it("responds on the path that renders and hands on down the other", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :require_login

  def require_login
    head :unauthorized if session[:user_id].nil?
  end
end
`);

    const unit = filterUnit(
      filters[0] as never,
      controllerActionsPattern(RAILS_LIKE),
      "app/controllers/orders.rb",
      { bodyContent: "statements" },
    );

    expect(unit.identity.kind).toBe("middleware");
    expect(unit.boundaryBinding).toBeNull();
    expect(unit.branches.map((branch) => branch.terminal.kind)).toEqual([
      "response",
      "delegate",
    ]);
  });

  it("hands on down every path when the method responds nowhere", async () => {
    const filters = await filtersOf(`
class OrdersController < ApplicationController
  before_action :load_order

  def load_order
    @order = Order.find(params[:id])
  end
end
`);

    const unit = filterUnit(
      filters[0] as never,
      controllerActionsPattern(RAILS_LIKE),
      "app/controllers/orders.rb",
      { bodyContent: "statements" },
    );

    expect(unit.branches.map((branch) => branch.terminal.kind)).toEqual([
      "delegate",
    ]);
  });
});
