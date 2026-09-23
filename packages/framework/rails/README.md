# @suss/framework-rails

Framework pack for [Rails](https://rubyonrails.org/) controller actions and the routes `config/routes.rb` gives them, read by the Ruby adapter.

## What this package is

`@suss/framework-rails` exports a `RubyPack`. It covers:

- **Discovery**: a class whose ancestry reaches `ApplicationController` (or an extra base the project lists), or that extends `ActionController::Base` or `ActionController::API` directly, as a health check or a `.well-known` controller often does to skip the app's own filters. Every public instance method the class defines directly is an action, whether it is `index`, `show` or a custom name. A method marked by a bare `private`/`protected`, a `private def name; end` or a `private :name` is not an action, since Rails never dispatches a request to one. It still gets a summary once an action's own calls reach it. A routed action that the controller inherits from a project ancestor is an action of the subclass as well, since Rails dispatches `GET /settings/profile` to whichever class in the chain defines `show`. It is reported under the subclass's name, with its location in the ancestor's file. A public method on an ancestor that nothing routes to the subclass is not reported for the subclass.
- **Routing**: `config/routes.rb` decides which method and path reach each action, and the pack reads it with a fixed grammar. That covers `resources`/`resource` with `only:`, `except:`, `controller:` and `path:`; `member`/`collection` blocks; nested `resources` to any depth; `module:` on a resource; `namespace`; `scope` with a positional path, `path:` or `module:`; the bare `get`/`post`/`patch`/`put`/`delete` calls with `to:` or the `"path" => "controller#action"` form; `match ... via:`; `root`; `draw(:name)`, which reads `config/routes/name.rb` under the scope it was written in; `constraints`, walked as if the block were not there, since it only narrows matching; `with_options`, whose keywords go to every call inside, with the call's own keywords winning; `concern`/`concerns`; `.each` or `.each_with_index` over a literal list; and `mount Name::Engine, at: "/prefix"` for an engine the project keeps in its own tree (see below). A loop such as `%w[users u].each do |root_path| ... end` is walked once per element with `root_path` bound, so `"#{root_path}/trusted-session"` and `path: root_path` come out as literal paths. When two routes point at the same action, the first one written wins, the same way Rails matches routes. An action the file routes becomes an HTTP boundary at that method and path. An action the file does not route is still discovered, and its calls are followed, but it has no boundary, the same as any other method in the run that gets a summary once something calls it.
- **Engines in the project's own tree**: a class that extends `Rails::Engine` has its own route set, drawn in the engine's `config/routes.rb` with `Name::Engine.routes.draw do ... end`. The app serves that set wherever it writes `mount Name::Engine, at: "/prefix"` (or `mount Name::Engine => "/prefix"`). Rails finds an engine by loading Ruby, so a project lists where its engines are in `engineRoots`, a list of directories. A `*` in a segment matches any one directory, so `plugins/*` covers every plugin. For each root, the pack reads the engine class under `lib/` and takes `isolate_namespace Name` as the module for every controller the engine routes, so `"invoices#index"` in the engine's routes means `Name::InvoicesController`. Then it reads the routes file. A mount inside a `scope` or `namespace` adds to that scope's path, and the engine's own module prefix applies whatever the scope's `module:` is, the same as in Rails. A `Rails.application.routes.draw`, `.append` or `.prepend` block in an engine's routes file adds to the app's own routes, in the order Rails runs them: every `prepend` first, then the `draw` blocks, then every `append`. If a project adds routes from some other file, such as a plugin's `plugin.rb` with a `Rails.application.routes.append do mount ... end` inside its `after_initialize` block, list those files under `routesFiles`. The pack reads the routing blocks in them at any depth.
- **Inflections the project registers**: `inflect.acronym "ActivityPub"` in `config/initializers/inflections.rb` changes how Rails maps a constant to a file and a routing key. `ActivityPub::InboxesController` lives at `activitypub/inboxes_controller.rb` and routes as `activitypub/inboxes`, where the plain rule would split it into `activity_pub`. The pack reads `acronym`, `irregular`, `uncountable` and `singular` with literal arguments from the files under `config/initializers`. It drops comments first, since the scaffolded file has every example written out in comments. The acronyms decide which file a constant lives in and which routing key a controller gets. All four go to the adapter, which checks them before ActiveSupport's own defaults when it works out which class `has_many :people` reaches. An argument built at run time, as in `WORDS.each { |w| inflect.acronym w }`, is not read.
- **Blocks that run as part of a class body**: ActiveSupport gives a class or module five calls whose block becomes part of the body it is written in. The pack declares all five, so the adapter reads what they declare as part of the class and does not lose it inside the block. A concern's `included` and `prepended` run their block against the class that includes the concern, and only a module has them. `class_methods` runs its block against a nested `ClassMethods` module that the including class extends, so a `def` there is a class method and is looked up as one. `Module#concerning` runs its block against a new module with `module_eval` and mixes that module in, and `Object#with_options` runs its block with extra keywords wherever it is written, so both apply in a class body as well as in a module. Without this declaration, a `has_many` or a `def` inside `included do` belongs to the block, and nothing can find it on the model.
- **A singular `resource`**: `resource :profile` serves six actions with no `:id` in any path, and Rails routes them to the plural `ProfilesController`. A resource or a bare verb inside its block goes under the resource's own path, as in `/profile/photos` and `/profile/avatar`, since there is no id to nest under. A bare verb inside a plural `resources` block nests under the member id instead, as in `/orders/:order_id/search`, the same as Rails.
- **Response status**: `render`, `head`, `redirect_to` and `redirect_back` all send a response. The pack declares those four calls and where each takes its status from, plus Rack's own `SYMBOL_TO_STATUS_CODE` table to turn a symbol into a number. Rack renamed four of those symbols across releases, and both spellings of each are declared. An action that sets no status of its own is reported at Rails' default of 200, and a redirect with no status is reported at 302.

  An action gets one transition for each path that can send a response. This `create`:

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

  reports two transitions: 201 when `item.save` succeeds, and 422 when it does not. A call written in one branch goes only on that branch's transition. A path that reaches the end of the body, or ends in a `return` with no response call, is Rails' implicit render, and is reported at 200.
- **Filters**: `before_action :require_login` runs a method before the action, and the request ends there if that method renders, heads or redirects. The pack declares `before_action` and `rescue_from`, and the adapter gives each named method a unit of its own. That unit records what the method responds with on the paths where it responds, and passes the request on along the others. Every action the filter covers records it, and the action reports the two combined:

  ```ruby
  class ApplicationController < ActionController::Base
    before_action :require_login

    private

    def require_login
      head :unauthorized if session[:user_id].nil?
    end
  end
  ```

  Every action in the project now reports 401 when there is no session, and its own outcomes under the negation of that test. `only:` and `except:` limit a filter to some of the actions, `skip_before_action` removes one again, and a filter on a base class applies to every controller that inherits from it. A `rescue_from ... with: :handler` runs only when the action raised, so what its method responds with is reported on the paths that raise.
- **The methods Rails gives every controller**: when an action uses `params[:id]`, `render`, `head`, `session` or `redirect_to`, it is calling something `ActionController::Base` or `ActionController::API` defines, which the project did not write. The pack declares those methods, and the adapter leaves them out of the action's effects. What remains is what the action reaches in the project: its services, its models and its own helpers. A controller method that a gem defines is a separate case, and a project lists those with `inheritedMethodNames` below.
- **The naming-convention fallback**: when the routes file this pack was given does not exist, every action named after one of Rails' seven conventional actions (`index`, `show`, `new`, `create`, `edit`, `update`, `destroy`) is bound at the method and path the convention gives it, and the run records one gap saying so. When the routes file does exist, it decides. An action it does not route stays unbound, even if its name looks conventional.

## Where it stops

- **A gem's block written in the routes grammar**: Devise's `devise_scope :user do ... end` and `authenticate :admin do ... end` wrap ordinary `get`, `resource` and `mount` calls, and neither changes the path or controller of what is inside. When the pack meets a call it does not know, and the call's block has at least one routing call at its top level, it walks the block the same way it walks `constraints`, under the enclosing scope. The file gets one gap saying so, since a gem could in principle prefix or rename what its block declares. A block with no routing call in it, such as `direct :homepage do ... end` building a URL, stays unread under the call's own name.
- **Anything the routes grammar above does not cover** is left unread, `direct` included. So is a routing call a gem adds, such as Devise's `devise_for` or Doorkeeper's `use_doorkeeper` (whose block configures controllers and declares no routes), since the gem decides what those route. A `mount` of something `engineRoots` does not reach, such as `Sidekiq::Web` or any other gem's engine, is unread in the same way, and so is a mount with no path. The routes file gets one gap listing which of those declarations appeared in it, so a reader knows the file declared more than this pack read, without one gap per line. A `draw(:name)` whose `routes/name.rb` is missing gets a gap of its own.
- **An engine is read from its class and its routes file only.** A route set built any other way is not read. That includes `Name::Engine.routes.draw` written in a file `engineRoots` does not cover, and an engine that draws into another engine. An engine with no `config/routes.rb` mounts nothing.
- **An action reachable by more than one verb** is bound to the first one written. `match '/hook', via: [:get, :post]` reports `GET /hook`, and `via: :all` reports the wildcard method.
- **Conditional routing.** A route wrapped in `if`/`unless`/`case` inside `routes.rb` is not read. The pack walks each block's direct statements, and does not run the file the way a Ruby interpreter would. A loop over anything other than a literal list (`Discourse.filters.each do |filter| ... end`) is skipped for the same reason: only the app's own code shows what that list contains.
- **`param:` on a resource** is not read, so a resource that renames its member parameter is still reported at `:id`.
- **Pluralization** for a singular `resource`, and for a nested resource's `:parent_id` parameter, uses a small heuristic in place of a full English inflector: `+s`, `y` -> `ies`, `ss`/`us`/`is`/`x`/`ch`/`sh` -> `+es`, and a name that already ends in `s` is left alone. It covers the regular names projects write. An irregular one (`resource :person`, which pluralizes to `people`) is out of scope.
- **A second response on the same path is not read.** Rails raises on a second render, so a statement that responds ends its path, and anything after it on that path is left out. `render :gone and return` followed by another `render` reports only the first.
- **`respond_to` is treated as a loop.** Each format block gets its own transition, under a condition saying that block ran, and there is one more transition for the path where none of them ran. Reading the source cannot tell which format the request asked for.
- **A helper called by its bare name is followed.** `render json: visible_items` calls `visible_items` on self, so the action gets an invocation effect for it and the helper gets its own summary, private or not. The Ruby adapter's README explains how a bare name is told apart from a read of a local variable. A method a gem defines on every controller is a call in the same way. The common one is `current_user` from Devise. It shows up on the summary as an invocation that nothing follows until the project lists it under `inheritedMethodNames`.
- **Visibility is read top to bottom, at the top level only.** A bare `private`/`protected`/`public`, a `private def name; end` and a `private :a, :b` are all read, in the order the class body has them. A visibility call inside an `if` or a block is not read, and a method it would have marked is treated as public.
- **`around_action` and `after_action` are not read.** The pack only declares the two calls that decide what a request returns. A filter written as a block instead of a method name is not read either, and neither is one whose method comes from a gem, since there is no body to read.
- **`routes.rb` is read once, on its own.** A route path or a `to:` target built from values the file itself sets is read to the string Rails serves. Those values can be a local variable in the draw block, a constant above it, an interpolation, `File.join`, or the default of an `ENV.fetch`. A path built from a value the file does not set, such as `ENV["PREFIX"]` or a method defined elsewhere, is not read, and the action it would have bound stays unbound.

## Where it fits in suss

The pack depends only on `@suss/adapter-ruby`, for the `RubyPack` type, the `controllerActions` discovery pattern it implements, and the parser it reads `config/routes.rb` with. Apart from the routes grammar in `routes.ts`, it has no analysis logic of its own.

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

`inheritedMethodNames` adds to the methods Rails itself defines, which the pack always declares. Use it for a controller method that comes from a gem or an engine, so that an action does not report a call to something the project never defines. `current_user` and `authenticate_user!` come from Devise, which is why they are not in the built-in list.

`root` and `routesFile` default to what `rails new` scaffolds, `app` and `config/routes.rb`. The CLI resolves a relative value, including a pattern in `engineRoots` or `routesFiles`, against the config file's directory when the options came from `-f rails=config.json`. For a bare `-f rails`, it resolves against the directory the run reads (`--dir`, or the working directory). A pack constructed in code with no `configDirectory` resolves against the working directory.

## Composing with ActiveRecord

A controller action's own database work, and that of anything it calls, comes from `@suss/framework-activerecord`. That is a separate pack that adds storage recognition to whichever pack a project already uses:

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
