import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { preloadRubyGrammar } from "@suss/adapter-ruby";

import { railsFramework } from "./index.js";

import type { ControllerActions } from "@suss/adapter-ruby";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-rails");

beforeAll(async () => {
  await preloadRubyGrammar();
});

function pattern(pack: ReturnType<typeof railsFramework>): ControllerActions {
  const [first] = pack.discovery;
  expect(first?.type).toBe("controllerActions");
  return first as ControllerActions;
}

describe("railsFramework", () => {
  it("states the pack's own shape, with Rails' vocabulary on the pattern", () => {
    const pack = railsFramework({
      root: path.join(fixtureRoot, "app"),
      routesFile: path.join(fixtureRoot, "config/routes.rb"),
    });
    expect(pack.name).toBe("rails");
    expect(pack.protocol).toBe("http");
    const p = pattern(pack);
    expect(p.baseClassNames).toEqual(["ApplicationController"]);
    expect(p.ancestryRootClassNames).toEqual([
      "ActionController::Base",
      "ActionController::API",
    ]);
    expect(p.pathConvention).toBe("railsUnderscore");
    expect(p.defaultStatusCode).toBe(200);
  });

  it("adds a project's own base class names alongside the default", () => {
    const pack = railsFramework({
      root: path.join(fixtureRoot, "app"),
      baseClassNames: ["Api::BaseController"],
    });
    expect(pattern(pack).baseClassNames).toEqual([
      "ApplicationController",
      "Api::BaseController",
    ]);
  });

  it("defaults root and routesFile to what rails new scaffolds", () => {
    const pack = railsFramework({ configDirectory: "/repo" });
    const p = pattern(pack);
    expect(p.root).toBe("/repo/app");
    expect(p.routesFile).toBe("/repo/config/routes.rb");
  });

  it("resolves a relative root and routesFile from the file options came from", () => {
    const pack = railsFramework({
      root: "app",
      routesFile: "config/routes.rb",
      configDirectory: "/repo",
    });
    const p = pattern(pack);
    expect(p.root).toBe("/repo/app");
    expect(p.routesFile).toBe("/repo/config/routes.rb");
  });

  it("leaves an absolute root and routesFile alone", () => {
    const pack = railsFramework({
      root: "/srv/app",
      routesFile: "/srv/config/routes.rb",
      configDirectory: "/repo",
    });
    const p = pattern(pack);
    expect(p.root).toBe("/srv/app");
    expect(p.routesFile).toBe("/srv/config/routes.rb");
  });

  it("declares the routes file as a discovery input so the cache key reads it", () => {
    const pack = railsFramework({
      routesFile: "config/routes.rb",
      configDirectory: "/repo",
    });
    expect(pack.discoveryInputs?.([])).toEqual(["/repo/config/routes.rb"]);
  });

  it("is the module's default export too", async () => {
    const mod = await import("./index.js");
    expect(mod.default).toBe(railsFramework);
  });

  describe("the route table fixtures/ruby-rails' routes.rb produces", () => {
    function routeFor(qualifiedName: string, actionName: string) {
      const pack = railsFramework({
        root: path.join(fixtureRoot, "app"),
        routesFile: path.join(fixtureRoot, "config/routes.rb"),
      });
      return pattern(pack).routeFor(qualifiedName, actionName);
    }

    it("binds the conventional resources actions the controller defines", () => {
      expect(routeFor("OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
      expect(routeFor("OrdersController", "show")).toEqual({
        method: "GET",
        path: "/orders/:id",
      });
    });

    it("binds a member route declared inside member do ... end", () => {
      expect(routeFor("OrdersController", "cancel")).toEqual({
        method: "POST",
        path: "/orders/:id/cancel",
      });
    });

    it("binds a bare get ... to: route with its own literal path", () => {
      expect(routeFor("OrdersController", "summary")).toEqual({
        method: "GET",
        path: "/orders/:id/summary",
      });
    });

    it("binds a resource nested one level inside another, with the parent's own id param", () => {
      expect(routeFor("ItemsController", "index")).toEqual({
        method: "GET",
        path: "/orders/:order_id/items",
      });
    });

    it("binds a namespaced resource under its module prefix and path prefix", () => {
      expect(routeFor("Admin::ReportsController", "index")).toEqual({
        method: "GET",
        path: "/admin/reports",
      });
    });

    it("leaves an action the routes file never reaches unbound", () => {
      expect(routeFor("OrdersController", "preview")).toBeNull();
    });

    it("reports the mount gap the same way on every call, not just the first", () => {
      const pack = railsFramework({
        root: path.join(fixtureRoot, "app"),
        routesFile: path.join(fixtureRoot, "config/routes.rb"),
      });
      const p = pattern(pack);
      expect(p.routingGaps?.()).toEqual([
        expect.stringContaining("also declares mount"),
      ]);
      expect(p.routingGaps?.()).toEqual([
        expect.stringContaining("also declares mount"),
      ]);
    });
  });

  describe("when the routes file does not exist", () => {
    function routeFor(qualifiedName: string, actionName: string) {
      const pack = railsFramework({
        root: path.join(fixtureRoot, "app"),
        routesFile: path.join(
          fixtureRoot,
          "config/routes-that-do-not-exist.rb",
        ),
      });
      return pattern(pack).routeFor(qualifiedName, actionName);
    }

    it("falls back to Rails' RESTful naming convention for a conventional action name", () => {
      expect(routeFor("OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
      expect(routeFor("OrdersController", "destroy")).toEqual({
        method: "DELETE",
        path: "/orders/:id",
      });
    });

    it("has nothing to say about a custom action name", () => {
      expect(routeFor("OrdersController", "cancel")).toBeNull();
    });

    it("records one gap saying the paths are assumed from naming", () => {
      const pack = railsFramework({
        root: path.join(fixtureRoot, "app"),
        routesFile: path.join(
          fixtureRoot,
          "config/routes-that-do-not-exist.rb",
        ),
      });
      const p = pattern(pack);
      expect(p.routingGaps?.()).toEqual([
        expect.stringContaining("RESTful naming convention"),
      ]);
    });
  });

  describe("the routes grammar, exercised through small snippets", () => {
    let dir: string;

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function routeFor(
      source: string,
      qualifiedName: string,
      actionName: string,
    ) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-routes-"));
      const file = path.join(dir, "routes.rb");
      fs.writeFileSync(file, source);
      const pack = railsFramework({ root: dir, routesFile: file });
      return pattern(pack).routeFor(qualifiedName, actionName);
    }

    it("gives a singular resource its six actions, no index and no :id", () => {
      const source =
        "Rails.application.routes.draw do\n  resource :profile\nend\n";
      expect(routeFor(source, "ProfilesController", "show")).toEqual({
        method: "GET",
        path: "/profile",
      });
      expect(routeFor(source, "ProfilesController", "update")).toEqual({
        method: "PATCH",
        path: "/profile",
      });
      expect(routeFor(source, "ProfilesController", "index")).toBeNull();
    });

    it("restricts resources to only: the listed conventional actions", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders, only: [:index]\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
      expect(routeFor(source, "OrdersController", "destroy")).toBeNull();
    });

    it("excludes an action listed under except:", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders, except: [:destroy]\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
      expect(routeFor(source, "OrdersController", "destroy")).toBeNull();
    });

    it("binds a route declared inside collection do ... end, with no :id", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders do\n" +
        "    collection do\n" +
        "      get :search\n" +
        "    end\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "search")).toEqual({
        method: "GET",
        path: "/orders/search",
      });
    });

    it("binds a bare verb route inside a resources block through on: :member", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders do\n" +
        "    post :cancel, on: :member\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "cancel")).toEqual({
        method: "POST",
        path: "/orders/:id/cancel",
      });
    });

    it("binds a bare verb route inside a resources block through on: :collection", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders do\n" +
        "    get :search, on: :collection\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "search")).toEqual({
        method: "GET",
        path: "/orders/search",
      });
    });

    it("does not bind a bare verb route inside a resources block with no on: and no wrapper", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders do\n" +
        "    get :search\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "search")).toBeNull();
    });

    it("applies scope path: and scope module: to everything nested inside it", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        '  scope module: "api", path: "v1" do\n' +
        "    resources :orders, only: [:index]\n" +
        "  end\nend\n";
      expect(routeFor(source, "Api::OrdersController", "index")).toEqual({
        method: "GET",
        path: "/v1/orders",
      });
    });

    it("binds root to: to a GET on /", () => {
      const source =
        'Rails.application.routes.draw do\n  root to: "welcome#index"\nend\n';
      expect(routeFor(source, "WelcomeController", "index")).toEqual({
        method: "GET",
        path: "/",
      });
    });

    it('binds the bare root "controller#action" spelling the same way', () => {
      const source =
        'Rails.application.routes.draw do\n  root "welcome#index"\nend\n';
      expect(routeFor(source, "WelcomeController", "index")).toEqual({
        method: "GET",
        path: "/",
      });
    });

    it("has nothing to say when the file declares no routes at all", () => {
      const source = "Rails.application.routes.draw do\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toBeNull();
    });

    it("skips a top-level call that carries no block before it finds the draw block", () => {
      const source =
        "SomeConfig.set(:x)\n" +
        "Rails.application.routes.draw do\n" +
        "  resources :orders, only: [:index]\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
    });

    it("skips a bare call written with a receiver inside the draw block", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  Rails.logger.info(:routing)\n" +
        "  resources :orders, only: [:index]\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
    });

    it("has nothing to say about a get ... to: target with no # separator", () => {
      const source =
        'Rails.application.routes.draw do\n  get "/reports", to: "reports"\nend\n';
      expect(routeFor(source, "ReportsController", "index")).toBeNull();
    });

    it("has nothing to say about resources with an unreadable name", () => {
      const source =
        "Rails.application.routes.draw do\n  resources name_variable\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toBeNull();
    });

    it("has nothing to say about namespace with an unreadable name", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  namespace name_variable do\n" +
        "    resources :orders\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toBeNull();
    });

    it("has nothing to say about a member block outside a resources block", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  member do\n" +
        "    post :cancel\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "cancel")).toBeNull();
    });
  });
});
