import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { preloadRubyGrammar } from "@suss/adapter-ruby";

import { railsFramework } from "./index.js";
import { readRoutes } from "./routes.js";

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

  it("declares the calls Rails gives an action for sending a response, with the status each redirect defaults to", () => {
    const p = pattern(railsFramework({ configDirectory: "/repo" }));
    expect(p.responseStatusCalls).toEqual([
      { name: "render", statusKeyword: "status" },
      { name: "head", statusArgument: 0, statusKeyword: "status" },
      { name: "redirect_to", statusKeyword: "status", defaultStatusCode: 302 },
      {
        name: "redirect_back",
        statusKeyword: "status",
        defaultStatusCode: 302,
      },
    ]);
  });

  it("declares Rack's status symbols, including the ones Rack renamed", () => {
    const p = pattern(railsFramework({ configDirectory: "/repo" }));
    expect(p.statusCodeNames).toMatchObject({
      ok: 200,
      created: 201,
      no_content: 204,
      not_found: 404,
      unprocessable_entity: 422,
      unprocessable_content: 422,
      internal_server_error: 500,
    });
  });

  it("declares the methods Rails gives every controller", () => {
    const p = pattern(railsFramework({ configDirectory: "/repo" }));
    expect(p.inheritedMethodNames).toContain("params");
    expect(p.inheritedMethodNames).toContain("render");
    expect(p.inheritedMethodNames).toContain("redirect_to");
    // Devise defines this one, so Rails' own list leaves it to a project.
    expect(p.inheritedMethodNames).not.toContain("current_user");
  });

  it("adds a project's own inherited methods alongside Rails' own", () => {
    const p = pattern(
      railsFramework({
        configDirectory: "/repo",
        inheritedMethodNames: ["current_user"],
      }),
    );
    expect(p.inheritedMethodNames).toContain("params");
    expect(p.inheritedMethodNames).toContain("current_user");
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

    it("takes a bare verb route's action from a string as well as a symbol", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders do\n" +
        '    collection { get "search" }\n' +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "search")).toEqual({
        method: "GET",
        path: "/orders/search",
      });
    });

    it("serves the action given by a bare verb's action: keyword at the path its first argument spells", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :rooms, only: [] do\n" +
        "    member do\n" +
        "      post :recording, action: :start_recording\n" +
        "      delete :recording, action: :stop_recording\n" +
        "    end\n" +
        "  end\n" +
        '  get "status", controller: "health", action: "show"\n' +
        "end\n";
      expect(routeFor(source, "RoomsController", "start_recording")).toEqual({
        method: "POST",
        path: "/rooms/:id/recording",
      });
      expect(routeFor(source, "RoomsController", "stop_recording")).toEqual({
        method: "DELETE",
        path: "/rooms/:id/recording",
      });
      expect(routeFor(source, "RoomsController", "recording")).toBeNull();
      expect(routeFor(source, "HealthController", "show")).toEqual({
        method: "GET",
        path: "/status",
      });
    });

    it("replays a block looped over a word list once per element", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  %w[users u].each_with_index do |root_path, index|\n" +
        '    get "#{root_path}" => "users#index", :constraints => { format: "html" }\n' +
        "    resources :users, only: %i[create], path: root_path do\n" +
        '      collection { get "check_username" }\n' +
        "    end\n" +
        '    get "#{root_path}/random-username" => "users#generate_random_username"\n' +
        '    get "#{root_path}/echo/#{index}" => "users#echo"\n' +
        "  end\n" +
        "  %w[guidelines rules conduct].each do |guidelines_alias|\n" +
        '    get guidelines_alias => "static#show", :id => "guidelines"\n' +
        "  end\n" +
        '  [:a, :b].each { |name| get name => "letters#show" }\n' +
        '  %i[c d].each { |name| get name => "symbols#show" }\n' +
        '  %w[e].map { |name| get name => "mapped#show" }\n' +
        '  %w[f].each { get "f" => "unbound#show" }\n' +
        '  [g].each { |name| get name => "unspelled#show" }\n' +
        "end\n";
      expect(routeFor(source, "UsersController", "index")).toEqual({
        method: "GET",
        path: "/users",
      });
      expect(routeFor(source, "UsersController", "create")).toEqual({
        method: "POST",
        path: "/users",
      });
      expect(routeFor(source, "UsersController", "check_username")).toEqual({
        method: "GET",
        path: "/users/check_username",
      });
      expect(
        routeFor(source, "UsersController", "generate_random_username"),
      ).toEqual({ method: "GET", path: "/users/random-username" });
      expect(routeFor(source, "UsersController", "echo")).toEqual({
        method: "GET",
        path: "/users/echo/0",
      });
      expect(routeFor(source, "StaticController", "show")).toEqual({
        method: "GET",
        path: "/guidelines",
      });
      expect(routeFor(source, "LettersController", "show")).toEqual({
        method: "GET",
        path: "/a",
      });
      expect(routeFor(source, "SymbolsController", "show")).toEqual({
        method: "GET",
        path: "/c",
      });
      expect(routeFor(source, "MappedController", "show")).toBeNull();
      expect(routeFor(source, "UnboundController", "show")).toBeNull();
      expect(routeFor(source, "UnspelledController", "show")).toBeNull();
    });

    it("leaves a loop over anything but a literal list unread", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  Discourse.filters.each do |filter|\n" +
        '    get "#{filter}" => "list##{filter}"\n' +
        "  end\n" +
        "end\n";
      expect(routeFor(source, "ListController", "latest")).toBeNull();
    });

    it("continues a hash-rocket route inside member or collection from the resource", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  namespace :admin do\n" +
        "    resources :backups, only: [:index] do\n" +
        "      member do\n" +
        '        put "" => "backups#email", :constraints => { id: /.+/ }\n' +
        '        post "restore" => "backups#restore"\n' +
        "      end\n" +
        "      collection do\n" +
        '        get "logs/:id" => "backup_logs#show"\n' +
        "      end\n" +
        "    end\n" +
        "  end\nend\n";
      expect(routeFor(source, "Admin::BackupsController", "email")).toEqual({
        method: "PUT",
        path: "/admin/backups/:id",
      });
      expect(routeFor(source, "Admin::BackupsController", "restore")).toEqual({
        method: "POST",
        path: "/admin/backups/:id/restore",
      });
      expect(routeFor(source, "Admin::BackupLogsController", "show")).toEqual({
        method: "GET",
        path: "/admin/backups/logs/:id",
      });
    });

    it("reads a keyword written with a hash rocket the same as with a colon", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        '  get "dashboard" => "dashboard#index", :constraints => { format: /json/ }\n' +
        "  resources :orders, :only => [:index]\n" +
        "end\n";
      expect(routeFor(source, "DashboardController", "index")).toEqual({
        method: "GET",
        path: "/dashboard",
      });
      expect(routeFor(source, "OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
      expect(routeFor(source, "OrdersController", "show")).toBeNull();
    });

    it("nests a bare verb route inside a resources block under the parent's id", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :orders do\n" +
        "    get :search\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "search")).toEqual({
        method: "GET",
        path: "/orders/:order_id/search",
      });
    });

    it("hangs a bare verb route inside a singular resource block off the resource itself", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resource :profile do\n" +
        "    get :avatar\n" +
        "  end\nend\n";
      expect(routeFor(source, "ProfilesController", "avatar")).toEqual({
        method: "GET",
        path: "/profile/avatar",
      });
    });

    it("nests a resource inside a singular resource under its path, with no id", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resource :profile do\n" +
        "    resources :photos, only: [:index]\n" +
        "  end\nend\n";
      expect(routeFor(source, "PhotosController", "index")).toEqual({
        method: "GET",
        path: "/profile/photos",
      });
    });

    it("routes a resource to the controller: it says, plural or singular", () => {
      const plural =
        "Rails.application.routes.draw do\n" +
        '  resources :items, controller: "widgets", only: [:index]\nend\n';
      expect(routeFor(plural, "WidgetsController", "index")).toEqual({
        method: "GET",
        path: "/items",
      });
      expect(routeFor(plural, "ItemsController", "index")).toBeNull();

      const singular =
        "Rails.application.routes.draw do\n" +
        '  resource :profile, controller: "users", only: [:show]\nend\n';
      expect(routeFor(singular, "UsersController", "show")).toEqual({
        method: "GET",
        path: "/profile",
      });
    });

    it("serves a resource at the path: it says, keyed by its own name", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        '  resources :items, path: "things" do\n' +
        "    resources :tags, only: [:index]\n" +
        "  end\nend\n";
      expect(routeFor(source, "ItemsController", "show")).toEqual({
        method: "GET",
        path: "/things/:id",
      });
      expect(routeFor(source, "TagsController", "index")).toEqual({
        method: "GET",
        path: "/things/:item_id/tags",
      });
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

    it("applies a positional scope path to a bare verb route inside it", () => {
      const source =
        'API = "/api"\n' +
        "Rails.application.routes.draw do\n" +
        '  scope "#{API}/v1" do\n' +
        '    get "users/:id", to: "users#show"\n' +
        "  end\nend\n";
      expect(routeFor(source, "UsersController", "show")).toEqual({
        method: "GET",
        path: "/api/v1/users/:id",
      });
    });

    it("writes one slash between a scope path and the route under it", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        '  scope path: "/v1/" do\n' +
        '    get "/users/:id", to: "users#show"\n' +
        '    get "/", to: "home#index"\n' +
        "  end\nend\n";
      expect(routeFor(source, "UsersController", "show")).toEqual({
        method: "GET",
        path: "/v1/users/:id",
      });
      expect(routeFor(source, "HomeController", "index")).toEqual({
        method: "GET",
        path: "/v1",
      });
    });

    it("keys a verb route and root inside a namespace under its module", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  namespace :api do\n" +
        '    get "users/:id", to: "users#show"\n' +
        '    root to: "home#index"\n' +
        "  end\nend\n";
      expect(routeFor(source, "Api::UsersController", "show")).toEqual({
        method: "GET",
        path: "/api/users/:id",
      });
      expect(routeFor(source, "Api::HomeController", "index")).toEqual({
        method: "GET",
        path: "/api",
      });
      expect(routeFor(source, "UsersController", "show")).toBeNull();
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

  describe("the routing calls a larger app spreads its routes across", () => {
    let dir: string;

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function packFor(source: string, drawn: Record<string, string> = {}) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-routes-"));
      const file = path.join(dir, "routes.rb");
      fs.writeFileSync(file, source);
      for (const [name, body] of Object.entries(drawn)) {
        fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
        fs.writeFileSync(path.join(dir, "routes", `${name}.rb`), body);
      }
      return railsFramework({ root: dir, routesFile: file });
    }

    function routeFor(
      source: string,
      qualifiedName: string,
      actionName: string,
      drawn: Record<string, string> = {},
    ) {
      return pattern(packFor(source, drawn)).routeFor(
        qualifiedName,
        actionName,
      );
    }

    it("reads a draw(:name) file under the scope the draw was written in", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  namespace :api do\n" +
        "    draw(:v1)\n" +
        "  end\nend\n";
      const drawn = { v1: "resources :orders, only: [:index]\n" };
      expect(routeFor(source, "Api::OrdersController", "index", drawn)).toEqual(
        { method: "GET", path: "/api/orders" },
      );
    });

    it("lists the drawn files beside the routes file as discovery inputs", () => {
      const pack = packFor(
        "Rails.application.routes.draw do\n  draw :v1\nend\n",
        {
          v1: "",
        },
      );
      expect(pack.discoveryInputs?.([])).toEqual([
        path.join(dir, "routes.rb"),
        path.join(dir, "routes", "v1.rb"),
      ]);
    });

    it("reports a draw whose file is missing as a gap", () => {
      const pack = packFor(
        "Rails.application.routes.draw do\n  draw(:missing)\nend\n",
      );
      const p = pattern(pack);
      expect(p.routeFor("OrdersController", "index")).toBeNull();
      expect(p.routingGaps?.()).toEqual([
        expect.stringContaining(
          "draws missing, but there is no missing.rb under routes/",
        ),
      ]);
    });

    it("walks a constraints block as if the block were not there", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  constraints(->(req) { req.format == :json }) do\n" +
        "    resources :orders, only: [:index]\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "index")).toEqual({
        method: "GET",
        path: "/orders",
      });
    });

    it("binds match ... via: to its first listed verb, and via: :all as a wildcard", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  match '/hook', to: 'hooks#receive', via: [:get, :post]\n" +
        "  match '/any', to: 'hooks#any', via: :all\n" +
        "end\n";
      expect(routeFor(source, "HooksController", "receive")).toEqual({
        method: "GET",
        path: "/hook",
      });
      expect(routeFor(source, "HooksController", "any")).toEqual({
        method: "*",
        path: "/any",
      });
    });

    it("replays a concern where a resource asks for it, in both spellings", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  concern :archivable do\n" +
        "    post :archive, on: :member\n" +
        "  end\n" +
        "  resources :orders, concerns: :archivable\n" +
        "  resources :invoices do\n" +
        "    concerns :archivable\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "archive")).toEqual({
        method: "POST",
        path: "/orders/:id/archive",
      });
      expect(routeFor(source, "InvoicesController", "archive")).toEqual({
        method: "POST",
        path: "/invoices/:id/archive",
      });
    });

    it("gives every call inside with_options its keywords, the call's own winning", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  with_options only: [:index] do\n" +
        "    resources :orders\n" +
        "    resources :invoices, only: [:show]\n" +
        "  end\nend\n";
      expect(routeFor(source, "OrdersController", "index")).not.toBeNull();
      expect(routeFor(source, "OrdersController", "show")).toBeNull();
      expect(routeFor(source, "InvoicesController", "show")).not.toBeNull();
      expect(routeFor(source, "InvoicesController", "index")).toBeNull();
    });

    it("puts a resource's controller under module: and keeps its path where it was", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :polls, only: [:show] do\n" +
        "    resources :votes, only: :create, module: :polls\n" +
        "  end\nend\n";
      expect(routeFor(source, "Polls::VotesController", "create")).toEqual({
        method: "POST",
        path: "/polls/:poll_id/votes",
      });
    });

    it("continues a scope inside a resource block from the resource's nested path", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resources :users, only: [] do\n" +
        "    scope module: :users do\n" +
        "      resource :role, only: [:show]\n" +
        "    end\n" +
        "  end\n" +
        "  resource :instance, only: [:show] do\n" +
        "    namespace :stats do\n" +
        "      resources :peers, only: [:index]\n" +
        "    end\n" +
        "  end\nend\n";
      expect(routeFor(source, "Users::RolesController", "show")).toEqual({
        method: "GET",
        path: "/users/:user_id/role",
      });
      expect(routeFor(source, "Stats::PeersController", "index")).toEqual({
        method: "GET",
        path: "/instance/stats/peers",
      });
    });

    it("routes a singular resource whose name already ends in s to that controller", () => {
      const source =
        "Rails.application.routes.draw do\n" +
        "  resource :settings, only: [:show]\n" +
        "  resource :status, only: [:show]\n" +
        "end\n";
      expect(routeFor(source, "SettingsController", "show")).toEqual({
        method: "GET",
        path: "/settings",
      });
      expect(routeFor(source, "StatusesController", "show")).toEqual({
        method: "GET",
        path: "/status",
      });
    });
  });

  describe("a path written as something other than one literal", () => {
    let dir: string;

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function routeFor(source: string, controller = "ReportsController") {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-routes-"));
      const file = path.join(dir, "routes.rb");
      fs.writeFileSync(file, source);
      const pack = railsFramework({ root: dir, routesFile: file });
      return pattern(pack).routeFor(controller, "index");
    }

    const drawn = (body: string, before = ""): string =>
      `${before}Rails.application.routes.draw do\n${body}\nend\n`;

    it("reads a local variable assigned inside the draw block", () => {
      const source = drawn(
        '  prefix = "/api"\n  get prefix + "/reports", to: "reports#index"',
      );
      expect(routeFor(source)).toEqual({ method: "GET", path: "/api/reports" });
    });

    it("reads a constant defined above the draw block", () => {
      const source = drawn(
        '  get "#{API}/reports", to: "reports#index"',
        'API = "/api"\n',
      );
      expect(routeFor(source)).toEqual({ method: "GET", path: "/api/reports" });
    });

    it("reads a variable from an enclosing block", () => {
      const source = drawn(
        '  version = "v1"\n' +
          "  namespace :api do\n" +
          '    get "/#{version}/reports", to: "reports#index"\n' +
          "  end",
      );
      expect(routeFor(source, "Api::ReportsController")).toEqual({
        method: "GET",
        path: "/api/v1/reports",
      });
    });

    it("reads File.join", () => {
      const source = drawn(
        '  get File.join("/api", "reports"), to: "reports#index"',
      );
      expect(routeFor(source)).toEqual({ method: "GET", path: "/api/reports" });
    });

    it("reads the default of an ENV.fetch", () => {
      const source = drawn(
        '  get ENV.fetch("PREFIX", "/api") + "/reports", to: "reports#index"',
      );
      expect(routeFor(source)).toEqual({ method: "GET", path: "/api/reports" });
    });

    it("reads a computed target and hash-rocket path", () => {
      const source = drawn(
        '  prefix = "/api"\n' +
          '  get prefix + "/reports" => "reports#" + "index"',
      );
      expect(routeFor(source)).toEqual({ method: "GET", path: "/api/reports" });
    });

    it("has nothing to say when the prefix cannot be read", () => {
      const source = drawn(
        '  get ENV["PREFIX"] + "/reports", to: "reports#index"',
      );
      expect(routeFor(source)).toBeNull();
    });
  });

  describe("engines the project keeps in its own tree", () => {
    let dir: string;

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const ENGINE_CLASS =
      "module Billing\n  class Engine < ::Rails::Engine\n    isolate_namespace Billing\n  end\nend\n";
    const ENGINE_ROUTES =
      "Billing::Engine.routes.draw do\n  resources :invoices, only: [:index]\nend\n";

    function write(relative: string, source: string): string {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      return file;
    }

    function projectWith(
      routes: string,
      files: Record<string, string> = {
        "engines/billing/lib/billing/engine.rb": ENGINE_CLASS,
        "engines/billing/config/routes.rb": ENGINE_ROUTES,
      },
      options: { routesFiles?: string[]; engineRoots?: string[] } = {},
    ) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-engines-"));
      write("config/routes.rb", routes);
      for (const [relative, source] of Object.entries(files)) {
        write(relative, source);
      }
      return railsFramework({
        configDirectory: dir,
        engineRoots: options.engineRoots ?? ["engines/*"],
        ...(options.routesFiles === undefined
          ? {}
          : { routesFiles: options.routesFiles }),
      });
    }

    const app = (body: string) =>
      `Rails.application.routes.draw do\n${body}\nend\n`;

    it("serves a mounted engine's routes under the mount path, keyed by its isolated namespace", () => {
      const pack = projectWith(app('  mount Billing::Engine, at: "/billing"'));
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/billing/invoices" });
      expect(pattern(pack).routingGaps?.()).toEqual([]);
    });

    it("reads an engine whose module is written with a leading ::, mounted at the root", () => {
      const pack = projectWith(
        'Discourse::Application.routes.draw { mount ::Billing::Engine, at: "/" }\n',
        {
          "engines/billing/lib/billing/engine.rb":
            "module ::Billing\n  class Engine < ::Rails::Engine\n    engine_name :billing\n    isolate_namespace Billing\n  end\nend\n",
          "engines/billing/config/routes.rb":
            'Billing::Engine.routes.draw do\n  get "/invoices" => "invoices#index"\nend\n',
        },
      );
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/invoices" });
    });

    it("reads the hash-rocket spelling of a mount", () => {
      const pack = projectWith(app('  mount Billing::Engine => "/billing"'));
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/billing/invoices" });
    });

    it("mounts under the scope the mount was written in, with the engine's own module prefix", () => {
      const pack = projectWith(
        app(
          '  scope "/api", module: "api" do\n    mount ::Billing::Engine, at: "billing"\n  end',
        ),
      );
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/api/billing/invoices" });
      expect(
        pattern(pack).routeFor("Api::Billing::InvoicesController", "index"),
      ).toBeNull();
    });

    it("reads an engine that isolates no namespace at the top-level controller key", () => {
      const pack = projectWith(app('  mount Billing::Engine, at: "/billing"'), {
        "engines/billing/lib/billing/engine.rb":
          "module Billing\n  class Engine < Rails::Engine\n    engine_name :billing\n  end\nend\n",
        "engines/billing/config/routes.rb": ENGINE_ROUTES,
      });
      expect(pattern(pack).routeFor("InvoicesController", "index")).toEqual({
        method: "GET",
        path: "/billing/invoices",
      });
    });

    it("adds an application draw block in an engine's routes file to the app's routes", () => {
      const pack = projectWith(app('  get "ping" => "status#show"'), {
        "engines/billing/lib/billing/engine.rb": ENGINE_CLASS,
        "engines/billing/config/routes.rb":
          `${ENGINE_ROUTES}\n` +
          'Rails.application.routes.draw do\n  get "health" => "billing/status#show"\nend\n',
      });
      expect(
        pattern(pack).routeFor("Billing::StatusController", "show"),
      ).toEqual({ method: "GET", path: "/health" });
    });

    it("reads a mount from a routes.append block nested inside another block in an extra file", () => {
      const pack = projectWith(
        app('  get "ping" => "status#show"'),
        {
          "engines/billing/lib/billing/engine.rb": ENGINE_CLASS,
          "engines/billing/config/routes.rb": ENGINE_ROUTES,
          "engines/billing/plugin.rb":
            "after_initialize do\n" +
            "  Rails.application.routes.append do\n" +
            '    mount ::Billing::Engine, at: "/billing"\n' +
            "  end\nend\n",
        },
        { routesFiles: ["engines/*/plugin.rb"] },
      );
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/billing/invoices" });
    });

    it("runs prepend blocks before the draw block and append blocks after, so the first route written wins", () => {
      const pack = projectWith(
        app('  get "first" => "status#show"'),
        {
          "extra/routes.rb":
            "Rails.application.routes.append do\n" +
            '  get "appended" => "status#show"\nend\n' +
            "Rails.application.routes.prepend do\n" +
            '  get "prepended" => "status#show"\nend\n',
        },
        { routesFiles: ["extra/routes.rb"], engineRoots: [] },
      );
      expect(pattern(pack).routeFor("StatusController", "show")).toEqual({
        method: "GET",
        path: "/prepended",
      });
    });

    it("reads a draw block owned by the app's own Application class", () => {
      const pack = projectWith(
        'Shop::Application.routes.draw do\n  mount Billing::Engine, at: "/billing"\nend\n',
      );
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/billing/invoices" });
    });

    it("reports a mount of something it knows no engine for as unread", () => {
      const pack = projectWith(app('  mount Sidekiq::Web => "/sidekiq"'));
      expect(pattern(pack).routingGaps?.()).toEqual([
        expect.stringContaining("also declares mount"),
      ]);
    });

    it("reports a mount with no path as unread", () => {
      const pack = projectWith(app("  mount Billing::Engine"));
      expect(pattern(pack).routingGaps?.()).toEqual([
        expect.stringContaining("also declares mount"),
      ]);
    });

    it("leaves an engine with no routes file mounted and empty", () => {
      const pack = projectWith(app('  mount Billing::Engine, at: "/billing"'), {
        "engines/billing/lib/billing/engine.rb": ENGINE_CLASS,
      });
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toBeNull();
      expect(pattern(pack).routingGaps?.()).toEqual([]);
    });

    it("stops an engine that mounts itself", () => {
      const pack = projectWith(app('  mount Billing::Engine, at: "/billing"'), {
        "engines/billing/lib/billing/engine.rb": ENGINE_CLASS,
        "engines/billing/config/routes.rb":
          "Billing::Engine.routes.draw do\n" +
          "  resources :invoices, only: [:index]\n" +
          '  mount Billing::Engine, at: "/again"\nend\n',
      });
      expect(
        pattern(pack).routeFor("Billing::InvoicesController", "index"),
      ).toEqual({ method: "GET", path: "/billing/invoices" });
    });

    it("lists every engine class file, engine routes file and extra file as a discovery input", () => {
      const pack = projectWith(
        app('  mount Billing::Engine, at: "/billing"'),
        {
          "engines/billing/lib/billing/engine.rb": ENGINE_CLASS,
          "engines/billing/config/routes.rb": ENGINE_ROUTES,
          "engines/billing/plugin.rb": "",
        },
        { routesFiles: ["engines/*/plugin.rb"] },
      );
      expect(pack.discoveryInputs?.([])).toEqual([
        path.join(dir, "config", "routes.rb"),
        path.join(dir, "engines", "billing", "lib", "billing", "engine.rb"),
        path.join(dir, "engines", "billing", "config", "routes.rb"),
        path.join(dir, "engines", "billing", "plugin.rb"),
      ]);
    });

    it("skips an engine root pattern that matches nothing, and a root with no lib/", () => {
      const pack = projectWith(
        app('  get "ping" => "status#show"'),
        {},
        {
          engineRoots: ["nowhere/*", "also/missing", "config"],
        },
      );
      expect(pattern(pack).routeFor("StatusController", "show")).toEqual({
        method: "GET",
        path: "/ping",
      });
      expect(pack.discoveryInputs?.([])).toEqual([
        path.join(dir, "config", "routes.rb"),
      ]);
    });

    it("skips a routes.draw block with no owner in front of routes, and lists a gem's routing call as unread", () => {
      const pack = projectWith(
        'routes.draw do\n  get "orphan" => "status#show"\nend\n' +
          app('  devise_for :users\n  get "ping" => "status#show"'),
      );
      const p = pattern(pack);
      expect(p.routeFor("StatusController", "show")).toEqual({
        method: "GET",
        path: "/ping",
      });
      expect(p.routingGaps?.()).toEqual([
        expect.stringContaining("also declares devise_for"),
      ]);
    });

    it("walks a gem's block written in the routes grammar under the enclosing scope, and says so", () => {
      const pack = projectWith(
        app(
          "  namespace :auth do\n" +
            "    devise_scope :user do\n" +
            "      resource :setup, only: [:show, :update], controller: :setup\n" +
            '      post "challenge", to: "challenges#create"\n' +
            "    end\n" +
            "  end\n" +
            '  direct :homepage do\n    "https://example.com"\n  end\n' +
            "  direct :commentable do |model|\n    route_for(model)\n  end",
        ),
      );
      const p = pattern(pack);
      expect(p.routeFor("Auth::SetupController", "update")).toEqual({
        method: "PATCH",
        path: "/auth/setup",
      });
      expect(p.routeFor("Auth::ChallengesController", "create")).toEqual({
        method: "POST",
        path: "/auth/challenge",
      });
      expect(p.routingGaps?.()).toEqual([
        expect.stringContaining("also declares direct"),
        "config/routes.rb wraps routes in devise_scope, which this pack does not know; it read the routes inside as though the wrapper changed nothing about their path or controller",
      ]);
    });

    it("reads nothing from an extra routes file that does not exist", () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-engines-"));
      const table = readRoutes({
        routesFile: {
          file: write("config/routes.rb", app('  get "ping" => "status#show"')),
          displayPath: "config/routes.rb",
        },
        engines: [],
        routesFiles: [
          { file: path.join(dir, "missing.rb"), displayPath: "missing.rb" },
        ],
      });
      expect(table.routeFor("status", "show")).toEqual({
        method: "GET",
        path: "/ping",
      });
      expect(table.gaps).toEqual([]);
    });
  });

  describe("acronyms the project registers with the inflector", () => {
    let dir: string;

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function write(relative: string, source: string): string {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      return file;
    }

    function projectWith(inflections: string | null) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rails-acronyms-"));
      write(
        "config/routes.rb",
        'Rails.application.routes.draw do\n  namespace :activitypub do\n    post "/inbox", to: "inboxes#create"\n  end\nend\n',
      );
      if (inflections !== null) {
        write("config/initializers/inflections.rb", inflections);
      }
      return railsFramework({ configDirectory: dir });
    }

    const INFLECTIONS =
      "ActiveSupport::Inflector.inflections(:en) do |inflect|\n  inflect.acronym 'ActivityPub'\nend\n";

    it("keys a controller under a registered acronym the way Rails does", () => {
      const pack = projectWith(INFLECTIONS);
      expect(
        pattern(pack).routeFor("ActivityPub::InboxesController", "create"),
      ).toEqual({ method: "POST", path: "/activitypub/inbox" });
      expect(pattern(pack).acronyms).toEqual(["ActivityPub"]);
    });

    it("splits the same name the ordinary way when nothing registers it", () => {
      const pack = projectWith(null);
      expect(
        pattern(pack).routeFor("ActivityPub::InboxesController", "create"),
      ).toBeNull();
      expect(pattern(pack).acronyms).toEqual([]);
    });

    it("declares the initializer as a discovery input so the cache key reads it", () => {
      const pack = projectWith(INFLECTIONS);
      expect(pack.discoveryInputs?.([])).toContain(
        path.join(dir, "config", "initializers", "inflections.rb"),
      );
    });
  });
});
