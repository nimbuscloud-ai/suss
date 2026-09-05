# @suss/framework-rails

Framework pack for [Rails](https://rubyonrails.org/) controller actions and the routes `config/routes.rb` gives them, read by the Ruby adapter.

## What this package is

`@suss/framework-rails` returns a `RubyPack` object describing:

- **Discovery**: a class whose ancestry reaches `ApplicationController` (or a project's own extra base). Every public instance method it defines directly is one of its actions, `index`, `show`, a custom name, whatever the controller writes. A method a bare `private`/`protected`, a `private def name; end`, or a `private :name` marks is not an action, the same way Rails itself never dispatches a request to one; it still gets a summary once an action's own calls reach it.
- **Routing**: `config/routes.rb` decides which method and path answer each action, so the pack reads it with a bounded grammar: `resources`/`resource` with `only:`, `except:`, `controller:` and `path:`, `member`/`collection` blocks, one level of nested `resources`, `namespace`, `scope` with a positional path, `path:` or `module:`, the bare `get`/`post`/`patch`/`put`/`delete` calls with `to:` or the `"path" => "controller#action"` spelling, and `root`. An action the file routes becomes an HTTP boundary at that method and path; an action it does not reach is still discovered, with its own calls followed into whatever it calls, only with no boundary, the same way any other unreached method in the run gets a summary once something calls it.
- **A singular `resource`**: `resource :profile` serves six actions with no `:id` in any path, and Rails routes them to the plural `ProfilesController`. A resource or a bare verb written inside its block hangs off the resource's own path, `/profile/photos` and `/profile/avatar`, since there is no id to nest under. A bare verb inside a plural `resources` block nests under the member id instead, `/orders/:order_id/search`, the same as Rails.
- **The naming-convention fallback**: when the routes file this pack was pointed at does not exist, every action named for one of Rails' seven conventional actions (`index`, `show`, `new`, `create`, `edit`, `update`, `destroy`) is bound at the method and path that convention gives it instead, and the run records one gap saying so. A routes file that does exist is the source of truth: an action it does not route stays unbound, even if its name looks conventional.

## Where it stops

- **Anything the routes grammar above does not cover**, `mount`, `draw`, `concern`, `constraints`, `match`, and `direct` among them, is left unread. The routes file it appeared in gets one gap listing which of those declarations were seen, so a reader knows the file said more than this pack read, without one gap per line.
- **Conditional routing.** A route wrapped in `if`/`unless`/`case` inside `routes.rb` is not read; this pack walks each block's direct statements, not everything a Ruby interpreter would eventually run.
- **`param:` on a resource** is not read, so a resource that renames its member parameter is still reported at `:id`.
- **Pluralization** for a singular `resource` and for a nested resource's `:parent_id` parameter is a small heuristic (`+s`, `y` -> `ies`, `s`/`x`/`ch`/`sh` -> `+es`), not a full English inflector. It covers the regular names a project actually writes; an irregular one (`resource :person`, pluralizing to `people`) is out of scope.
- **Visibility read top to bottom, at the top level only.** A bare `private`/`protected`/`public`, a `private def name; end`, and a `private :a, :b` are all read, in the order the class body writes them. A visibility call wrapped in an `if` or written inside a block is not; a method it would have marked is read as public instead.
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
});
```

`root` and `routesFile` both default to what `rails new` scaffolds, `app` and `config/routes.rb`. The CLI resolves a relative value against the config file's directory when the options came from `-f rails=config.json`, and against the directory the run reads (`--dir`, or the working directory) for a bare `-f rails`. A pack constructed in code with no `configDirectory` resolves against the working directory.

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
