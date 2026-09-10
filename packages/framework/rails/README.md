# @suss/framework-rails

Framework pack for [Rails](https://rubyonrails.org/) controller actions and the routes `config/routes.rb` gives them, read by the Ruby adapter.

## What this package is

`@suss/framework-rails` returns a `RubyPack` object describing:

- **Discovery**: a class whose ancestry reaches `ApplicationController` (or a project's own extra base), or that extends `ActionController::Base` or `ActionController::API` directly, the way a health check or a `.well-known` controller often does to skip the app's own filters. Every public instance method it defines directly is one of its actions, `index`, `show`, a custom name, whatever the controller writes. A method a bare `private`/`protected`, a `private def name; end`, or a `private :name` marks is not an action, the same way Rails itself never dispatches a request to one; it still gets a summary once an action's own calls reach it.
- **Routing**: `config/routes.rb` decides which method and path answer each action, so the pack reads it with a bounded grammar: `resources`/`resource` with `only:`, `except:`, `controller:` and `path:`, `member`/`collection` blocks, nested `resources` to any depth, `module:` on a resource, `namespace`, `scope` with a positional path, `path:` or `module:`, the bare `get`/`post`/`patch`/`put`/`delete` calls with `to:` or the `"path" => "controller#action"` spelling, `match ... via:`, `root`, `draw(:name)` reading `config/routes/name.rb` under the scope it was written in, `constraints` (walked as if the block were not there, since it only narrows matching), `with_options` (its keywords go to every call inside, the call's own winning), `concern`/`concerns`, and `.each` or `.each_with_index` over a literal list (`%w[users u].each do |root_path| ... end` is walked once per element with `root_path` bound, so `"#{root_path}/trusted-session"` and `path: root_path` come out spelled), and `mount Name::Engine, at: "/prefix"` for an engine the project keeps in its own tree (see below). When two routes name the same action, the first one written wins, the way Rails matches its routes. An action the file routes becomes an HTTP boundary at that method and path; an action it does not reach is still discovered, with its own calls followed into whatever it calls, only with no boundary, the same way any other unreached method in the run gets a summary once something calls it.
- **Engines in the project's own tree**: a class extending `Rails::Engine` has a route set of its own, drawn in the engine's `config/routes.rb` with `Name::Engine.routes.draw do ... end`, and the app serves that set wherever it writes `mount Name::Engine, at: "/prefix"` (or `mount Name::Engine => "/prefix"`). Rails finds an engine by loading Ruby, so a project says where its engines are with `engineRoots`, a list of directories (a `*` in a segment matches any one directory, so `plugins/*` covers every plugin). For each root the pack reads the engine class under `lib/`, takes `isolate_namespace Name` inside it as the module every controller the engine routes is under (`"invoices#index"` in the engine's routes means `Name::InvoicesController`), and reads the routes file. A mount inside a `scope` or `namespace` continues from that scope's path, and the engine's own module prefix applies regardless of the scope's `module:`, the same as Rails. Any `Rails.application.routes.draw`, `.append` or `.prepend` block written in an engine's routes file adds to the app's own routes, in the order Rails runs them: every `prepend` first, then the `draw` blocks, then every `append`. A project that adds routes from some other file, a plugin's `plugin.rb` with a `Rails.application.routes.append do mount ... end` inside its `after_initialize` block say, lists those files under `routesFiles`, and the pack reads the routing blocks at any depth in them.
- **Inflector acronyms**: a project that writes `inflect.acronym "ActivityPub"` in `config/initializers/inflections.rb` changes how Rails maps a constant to a file and a routing key: `ActivityPub::InboxesController` lives at `activitypub/inboxes_controller.rb` and routes as `activitypub/inboxes`, where the plain rule would split it to `activity_pub`. The pack reads every `.acronym` with a string literal from the files under `config/initializers` and applies them the way ActiveSupport does, both when the adapter follows a controller's ancestry to a base's file and when the pack turns a controller's name into its routing key. An acronym built at runtime, `WORDS.each { |w| inflect.acronym w }`, is not read.
- **A singular `resource`**: `resource :profile` serves six actions with no `:id` in any path, and Rails routes them to the plural `ProfilesController`. A resource or a bare verb written inside its block hangs off the resource's own path, `/profile/photos` and `/profile/avatar`, since there is no id to nest under. A bare verb inside a plural `resources` block nests under the member id instead, `/orders/:order_id/search`, the same as Rails.
- **Response status**: `render`, `head`, `redirect_to` and `redirect_back` all send a response, so the pack declares those four calls and where each takes its status, plus Rack's own `SYMBOL_TO_STATUS_CODE` table so that a symbol becomes a number. Rack renamed four of those symbols over its releases, and both spellings of each are declared. An action that sets no status of its own is reported at Rails' default of 200, and a redirect that writes none is reported at 302.

  An action gets one transition per path it can respond on. This `create`:

  ```ruby
  def create
    item = Item.new(item_params)
    if item.save
      render json: item, status: :created
    else
      render json: item.errors, status: :unprocessable_entity
    end
  end
  ```

  reports two transitions: 201 when `item.save`, and 422 when it does not. A call written in one arm goes on that arm's transition alone. A path that reaches the end of the body, or that ends in a `return` with no response call, is Rails' implicit render and is reported at 200.
- **Filters**: `before_action :require_login` runs a method before the action, and the request ends there when that method renders, heads or redirects. The pack declares `before_action` and `rescue_from`, and the adapter gives each named method a unit of its own, saying what it responds with on the paths where it responds and handing the request on down the rest. Every action the filter covers records it, and what the action reports is the two composed:

  ```ruby
  class ApplicationController < ActionController::Base
    before_action :require_login

    private

    def require_login
      head :unauthorized if session[:user_id].nil?
    end
  end
  ```

  Every action in the project now reports 401 when there is no session, and its own outcomes under the negation of that test. `only:` and `except:` narrow a filter to some of the actions, `skip_before_action` takes one back off, and a filter written on a base class reaches every controller that inherits it. A `rescue_from ... with: :handler` runs only when the action raised, so what its method responds with is reported on the paths that raise.
- **The methods Rails gives every controller**: an action that writes `params[:id]`, `render`, `head`, `session` or `redirect_to` is using something `ActionController::Base` or `ActionController::API` defines, not something the project wrote, so the pack declares those methods and the adapter leaves them off the action's effects. What is left is what the action reaches in the project: its services, its models, its own helpers. A gem that defines a controller method of its own is a separate matter, and a project says so with `inheritedMethodNames` below.
- **The naming-convention fallback**: when the routes file this pack was pointed at does not exist, every action named for one of Rails' seven conventional actions (`index`, `show`, `new`, `create`, `edit`, `update`, `destroy`) is bound at the method and path that convention gives it instead, and the run records one gap saying so. A routes file that does exist is the source of truth: an action it does not route stays unbound, even if its name looks conventional.

## Where it stops

- **Anything the routes grammar above does not cover**, `direct` among them, is left unread, and so is a routing call a gem adds, such as Devise's `devise_for` or Doorkeeper's `use_doorkeeper`, since what those route is defined by the gem rather than the app. A `mount` of something `engineRoots` does not reach, `Sidekiq::Web` or any other gem's engine, is unread the same way, and so is a mount with no path. The routes file it appeared in gets one gap listing which of those declarations were seen, so a reader knows the file said more than this pack read, without one gap per line. A `draw(:name)` whose `routes/name.rb` is missing gets a gap of its own.
- **An engine is read from its class and its routes file only.** A route set built any other way, `Name::Engine.routes.draw` written in a file `engineRoots` does not cover, or an engine that draws into another engine, is not read. An engine with no `config/routes.rb` mounts nothing.
- **An action reachable by more than one verb** is bound to the first one written. `match '/hook', via: [:get, :post]` reports `GET /hook`; `via: :all` reports the wildcard method.
- **Conditional routing.** A route wrapped in `if`/`unless`/`case` inside `routes.rb` is not read; this pack walks each block's direct statements, not everything a Ruby interpreter would eventually run. A loop over anything but a literal list (`Discourse.filters.each do |filter| ... end`) is skipped for the same reason: only the app's own code says what that list contains.
- **`param:` on a resource** is not read, so a resource that renames its member parameter is still reported at `:id`.
- **Pluralization** for a singular `resource` and for a nested resource's `:parent_id` parameter is a small heuristic (`+s`, `y` -> `ies`, `ss`/`us`/`is`/`x`/`ch`/`sh` -> `+es`, a name already ending in `s` left alone), not a full English inflector. It covers the regular names a project actually writes; an irregular one (`resource :person`, pluralizing to `people`) is out of scope.
- **A second response on the same path is not read.** Rails raises on a second render, so a statement that responds ends its path and anything written after it on that path is left out. `render :gone and return` followed by another `render` reports the first one only.
- **`respond_to` is treated as a loop.** Each format block gets its own transition, gated on a condition saying that block ran, and there is a further transition for the path where none of them did. Which format the request asked for is not something a reader of the source can settle.
- **A helper called by its bare name is followed.** `render json: visible_items` calls `visible_items` on self, so the action gets an invocation effect for it and the helper gets a summary of its own, private or not. The Ruby adapter's README says how a bare name is told apart from a local variable read. A method a gem defines on every controller, `current_user` from Devise being the common one, is a call the same way, and shows up on the summary as an invocation nothing follows until a project lists it under `inheritedMethodNames`.
- **Visibility read top to bottom, at the top level only.** A bare `private`/`protected`/`public`, a `private def name; end`, and a `private :a, :b` are all read, in the order the class body writes them. A visibility call wrapped in an `if` or written inside a block is not; a method it would have marked is read as public instead.
- **`around_action` and `after_action` are not read.** Only the two calls that decide what a request comes back with are declared. A filter written as a block rather than a method name is not read either, and neither is one whose method a gem defines rather than the project, since there is no body to say what it does.
- **`routes.rb` is read once, standalone.** A route path or a `to:` target built from what the file itself states, a local variable in the draw block, a constant above it, an interpolation, `File.join`, or the default of an `ENV.fetch`, is read to the string Rails serves. One built from a value the file does not state, `ENV["PREFIX"]` or a method defined elsewhere, is not read, and the action it would have bound stays unbound.

## Where it fits in suss

Depends only on `@suss/adapter-ruby`, for the `RubyPack` type, the `controllerActions` discovery pattern it implements against, and the parser this pack reads `config/routes.rb` with. Contains no analysis logic of its own beyond the routes grammar in `routes.ts`.

## Configuration

```ts
import { railsFramework } from "@suss/framework-rails";

const pack = railsFramework({
  root: path.join(repoRoot, "app"),
  routesFile: path.join(repoRoot, "config/routes.rb"),
  // A project that mounts an extra controller base beyond ApplicationController:
  baseClassNames: ["Api::BaseController"],
  // Controller methods a gem defines, which Rails itself does not:
  inheritedMethodNames: ["current_user", "authenticate_user!"],
  // Directories with an engine the app mounts, each with a lib/ and a config/routes.rb:
  engineRoots: ["engines/*"],
  // Other files that add routes through Rails.application.routes.draw, .append or .prepend:
  routesFiles: ["plugins/*/plugin.rb"],
});
```

`engineRoots` and `routesFiles` are empty by default, since `rails new` scaffolds neither. A `*` in a segment of either matches any one directory or file name, and a pattern that matches nothing is skipped. A project that keeps its engines as plugins, each under `plugins/<name>` with a `plugin.rb` that mounts the engine, sets both: `{ "engineRoots": ["plugins/*"], "routesFiles": ["plugins/*/plugin.rb"] }`.

`inheritedMethodNames` adds to the methods Rails itself defines, which the pack always declares. Use it for a controller method that comes from a gem or from an engine, so that an action does not report a call nothing in the project defines. `current_user` and `authenticate_user!` belong to Devise rather than to Rails, which is why they are not in the shipped list.

`root` and `routesFile` both default to what `rails new` scaffolds, `app` and `config/routes.rb`. The CLI resolves a relative value, a pattern in `engineRoots` or `routesFiles` included, against the config file's directory when the options came from `-f rails=config.json`, and against the directory the run reads (`--dir`, or the working directory) for a bare `-f rails`. A pack constructed in code with no `configDirectory` resolves against the working directory.

## Composing with ActiveRecord

A controller action's own database work, and the database work of anything it calls, comes from `@suss/framework-activerecord`, a separate pack that adds storage recognition to whichever pack a project already uses:

```ts
import { railsFramework } from "@suss/framework-rails";
import { withActiveRecord } from "@suss/framework-activerecord";

const pack = withActiveRecord(railsFramework({ root: "app" }), {
  storageSystem: "postgresql",
});
```

## Coverage

![coverage](../../../.github/badges/coverage-rails.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
