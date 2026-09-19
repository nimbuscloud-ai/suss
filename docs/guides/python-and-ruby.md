---
title: Read Python or Ruby
description: Point suss at a FastAPI, flask-restx, Rails or graphql-ruby project and get the same summaries a TypeScript project gives, so both sides compare in one run.
---

# Read Python or Ruby

Point `suss extract` at the directory instead of a tsconfig, and name the packs for the frameworks the project uses.

```bash
npx suss extract --dir services/shop -f fastapi -o summaries/shop.json
npx suss inspect summaries/shop.json
```

The summaries are the same format a TypeScript run writes, so `check` compares a Python handler against a TypeScript client in one pass. Neither adapter needs an installed interpreter, a virtualenv or a bundle. Both parse with tree-sitter compiled to WASM, which ships inside the CLI.

## Let init pick the packs

```bash
npx suss init services/shop --plain
```

For a Python project it reads `requirements.txt` and the other requirements files beside it, `pyproject.toml` (the standard table and Poetry's two), `Pipfile`, `setup.cfg` and a literal `install_requires` list in `setup.py`. For a Ruby project it reads `Gemfile.lock`. Over this repo's `fixtures/python-webapp`:

```
✓ Found 2 things to read

  Your code
    fastapi          fastapi in requirements.txt
    flask-restx      flask-restx in requirements.txt

1. Install suss

   npm install --save-dev @suss/cli

2. Read each side into one folder

   suss extract --lang python -f fastapi -f flask-restx -o summaries/code.json
```

When `init` looked somewhere and could not read it, it prints that on its own line. A `setup.py` that computes its dependency list, a conda environment file, or a `Gemfile` with no lock file beside it each get one of those lines, because suss cannot suggest a pack for a library that only appears there.

## Which packs read which language

The [pack catalog](/packs/catalog) lists every pack and what it reads. In short:

- **In Python**, suss reads routes with `fastapi` or `flask-restx`, database calls with `sqlalchemy` or `sqlmodel`, and outbound HTTP with `requests`, `httpx` or `aiohttp`.
- **In Ruby**, suss reads GraphQL fields with `graphql-ruby`, Rails controller actions with `rails`, database calls with `activerecord`, and outbound HTTP with `faraday` or `net-http`.

A pack for one language cannot run alongside a pack for another in the same command. Within one language you can combine them freely: `-f rails -f activerecord=suss.activerecord.json` gives you the controller actions and the tables each one touches.

## Python

```bash
npx suss extract --dir fixtures/python-fastapi -f fastapi -o summaries/shop.json
npx suss inspect summaries/shop.json
```

```
shop/main.py
├─ GET /health  (fastapi handler | line 24 | confidence: low)
│      -> 200 HealthStatus
│
├─ POST /orders  (fastapi handler | line 29 | confidence: low)
│      -> 201
│
└─ GET ?  (fastapi handler | line 34 | confidence: low)

       !! The path in this route's decorator is not a string literal, so the binding names no path and nothing pairs with it

shop/routers/admin.py
└─ GET ?  (fastapi handler | line 13 | confidence: low)

       !! The router this route is declared on is mounted with a prefix that is not a string literal, so the binding names no path and nothing pairs with it

shop/routers/items.py
├─ current_user  (line 24 | confidence: low)
│      -> delegate -> unknown
│
├─ GET /api/items/{item_id}  (fastapi handler | line 32 | confidence: low)
│      -> 200 ItemResponse
│
├─ POST /api/items  (fastapi handler | line 37 | wrapped by current_user (shop/routers/items.py) | confidence: low)
│      -> 201 ItemResponse
│
└─ GET /api/items/{item_id}/stock  (fastapi handler | line 42 | confidence: low)
       if  item_id > 10
         -> 404
           + HTTPException
       else
         -> 200 { count }
```

Three things in there are worth pointing at.

`/api/items/{item_id}` is whole even though no file writes it whole. The router declares `prefix="/items"` and `app.include_router(items_router, prefix="/api")` mounts it under another, and the pack composes the two, one mount hop deep, when both are string literals.

`read_stock` shows what the adapter does with a body. Each return becomes a branch with its status and the conditions that reach it, and `raise HTTPException(status_code=404, ...)` is the 404. FastAPI resolves `Depends(current_user)` on `create_item` itself, and the caller never sends it, so it is no part of the request.

The two `GET ?` lines are routes whose path the source does not state. One reads its path from settings, and the other is mounted under a prefix that comes from the environment. They keep their names, they get no path, and the output explains why. A route with no path pairs with nothing, and a guessed path would pair it with somebody else's handler, so every finding about it would be about the wrong route.

What `extract` reads, and from where:

- **Every `.py` file** under the directory, skipping `__pycache__`, `.venv`, `venv`, `node_modules` and `.git`. Name a subset with `--files`.
- **The directory you pointed at, plus each checked-out submodule**, as the roots an absolute import resolves against. That is the closest thing a Python project has to a tsconfig's `paths`. A module found under two roots comes back ambiguous rather than resolved, because which one wins is a `sys.path` fact only a running interpreter has. A submodule that was never checked out is reported, and with `-o` it is also written to a note beside the summaries, so a CI job reading the summaries can tell the run was incomplete.
- **The packs.** No other part of the adapter has a decorator name in it.

suss works out that a directory is Python from a `pyproject.toml`, a requirements file, `setup.py` or `Pipfile`, and failing those from the `.py` files themselves. The packs you ask for decide it too, and `--lang python` states it directly.

### flask-restx

Each HTTP-verb-named method on a decorated `Resource` class becomes its own route, the verb from the method name and the path from the decorator's first string argument. Werkzeug converters are canonicalized, so `/orders/<int:order_id>` comes out as `/orders/{order_id}` with `order_id` as a path parameter. A method with a return annotation gets one transition for that type under a 200. `@ns.marshal_with` and `@ns.expect` are not read yet.

A route declared on a namespace is served under the namespace's own path, and the pack composes the two:

```python
from flask_restx import Namespace

ns = Namespace("orders", path="/orders")

@ns.route("/<int:order_id>")
class OrderDetail:
    def get(self, order_id): ...
```

With `api.add_namespace(ns)` somewhere in the files the run reads, that comes out as `GET /orders/{order_id}`. For the composition to happen, the namespace has to be constructed with a literal `path` and mounted once, through a variable, by an `add_namespace` that gives no path of its own. Written any other way, the route is still discovered under its name, with no path and a recorded reason. The README of `@suss/adapter-python` has the grid of what every spelling means at each site.

### FastAPI

- The verb comes from the decorator's own attribute name, so `@app.post("/orders")` is a POST. The app or router is recognized by construction, `app = FastAPI()` or `router = APIRouter()`, one assignment back from an import of `fastapi`.
- `response_model=` and `status_code=` are taken as what the route declares. With neither written, the return annotation supplies the body. With a body read and no status written, the status is 200.
- A route on a router composes its path from the router's own `prefix` and the `prefix` at the `include_router(...)` call that mounts it, one hop deep, when both are string literals.

Dependencies, middleware and mounted sub-apps are not read yet.

## Ruby

The rails pack needs nothing from you: `root` defaults to `app` and `routesFile` to `config/routes.rb`.

```bash
npx suss extract --dir fixtures/ruby-rails -f rails -f activerecord=suss.activerecord.json -o summaries/rails.json
npx suss inspect summaries/rails.json
```

`suss.activerecord.json` tells suss which database is behind the connection. ActiveRecord talks to several of them, and only `database.yml` decides which one:

```json
{ "storageSystem": "postgresql" }
```

```
app/controllers/profiles_controller.rb
├─ GET /profile  (rails handler | line 4 | wrapped by require_login (app/controllers/application_controller.rb), not_found (app/controllers/application_controller.rb) on a throw | confidence: low)
│      if  session[:user_id] == null
│        -> 401  (from require_login)
│      else
│        -> 200
│          + app/services/order_service.find_order →
│
│    Reaches:
│      reads postgresql:Order  through OrderService.new.find_order
│
└─ PATCH /profile  (rails handler | line 8 | wrapped by require_login (app/controllers/application_controller.rb), not_found (app/controllers/application_controller.rb) on a throw | confidence: low)
       if  session[:user_id] == null
         -> 401  (from require_login)
       else
         -> 200
           + app/services/order_service.cancel_order →

     Reaches:
       writes postgresql:Order  through OrderService.new.cancel_order

config/routes.rb
└─ routes  (line 1 | confidence: low)
       -> void

       !! config/routes.rb also declares mount, which this pack does not read; whatever those declarations route is missing from what suss reports
```

Every instance method a controller extending `ApplicationController` defines directly is one of its actions, and `config/routes.rb` decides the method and path. `before_action` filters come through as wrappers, so the 401 on both actions belongs to `require_login`, and the summary records that. `Reaches:` follows the call into the service object and reports the table at the other end, with the chain that got there.

The pack reads most of the routes grammar:

- `resources` and `resource`, with `only:`, `except:`, `controller:`, `path:` and `module:`
- `member` and `collection` blocks, and the `on: :member` keyword form
- nested resources to any depth
- `namespace`, and `scope` with a positional path, `path:` or `module:`
- the bare `get`/`post`/`patch`/`put`/`delete` calls, with `to:`, with `controller:` and `action:`, or in the `"path" => "controller#action"` spelling
- `root`, both spellings
- `match` with `via:`, bound to the first verb listed, and `via: :all` as the wildcard method
- `constraints`, walked as if the block were not there, since it only narrows matching
- `concern` and `concerns`, in both spellings
- `draw(:name)`, read from `config/routes/name.rb` under the scope the draw was written in
- `mount`, for an engine the project keeps in its own tree, which the `engineRoots` option points at

Anything the pack does not read, it records instead of guessing at. That is the `mount Sidekiq::Web` line above: a gem's engine is outside `engineRoots`, so the gap tells you which call went unread. `direct`, `param:` on a resource and a gem routing call like `devise_for` go the same way.

An action the routes file does not reach is still discovered, with its calls followed, only with no boundary. When the routes file is missing altogether, every action named for one of Rails' seven conventional actions is bound at the path Rails' own naming convention gives it, and the run records that it did so.

### graphql-ruby

```bash
npx suss extract --dir . -f graphql-ruby=suss.graphql-ruby.json -o summaries/schema.json
```

```json
{ "root": "app/graphql" }
```

| Option | Default | What it does |
|---|---|---|
| `root` | required | The directory a `mutation:` or `resolver:` reference resolves against, through Rails' constant-to-path convention. `Mutations::CampaignUpdate` is read from `<root>/mutations/campaign_update.rb`. Your layout is your project's, so there is no default and the pack reads nothing without one. A relative path is read against the config file it was written in. |
| `camelize` | `true` | graphql-ruby's schema-wide default for exposing a snake_case symbol camelCased. Set it to `false` when your schema does. A `field` or `argument` call's own `camelize:` still wins for that one name, as it does at runtime. |

A class extending one of graphql-ruby's generated base classes has each `field` call in its body turned into a resolver, named `Campaign.id` from the class's short name with a trailing `Type` stripped. The binding is `graphql-resolver(typeName, fieldName)`, so it pairs against a client operation exactly as a NestJS or Apollo resolver summary does. The adapter follows a class's whole ancestry, so an intermediate base of yours needs nothing said about it.

`field :campaign_update, mutation: Mutations::CampaignUpdate` is followed one hop: the referenced class is located under `root`, and its own `field` and `argument` calls become the payload and the arguments. An `argument` counts as required unless it declares otherwise.

In Ruby suss abstains per field, the same way it abstains per route in Python. `field :status, status_label_for(:organizer)` is discovered as `Organizer.status` with no declared contract at all, instead of one claiming the type is unknown. A `mutation:` reference pointing at a file that is not where the convention says it should be gives you the field and no payload.

A `Gemfile`, a `Gemfile.lock` or a Rails `config/application.rb` is enough for suss to read a directory as Ruby, and `--lang ruby` states it directly. The walk reads every `.rb` file, skipping `vendor`, `node_modules`, `tmp` and `.git`. Ruby constants resolve through class and module nesting, and suss does not follow `require`, so Ruby has no equivalent of Python's import roots.

## Configuring a pack

Most packs need nothing from you, because everything they match on is something their library defines. Where a pack does need a sentence about your project, write it to a JSON file and give the file name on the flag:

```bash
npx suss extract --lang ruby --dir . -f graphql-ruby=suss.graphql-ruby.json
```

A pack that cannot work without a value tells you and stops, instead of reading half a project quietly. A relative path in an option is read against the config file itself, so the same file works whichever directory you run from.

A pack config states something about your own project. A fact about a package you depend on, such as a module of yours that re-exports a framework, goes in a [dependency stub](/guides/teach-a-dependency) instead.

## Your own wrapper around a route decorator

Most services wrap flask-restx's route decorator in a module of their own rather than importing it at every route file:

```python
# myapp/wrappers/restx.py
from flask_restx import Namespace

api = Namespace("todos")

def route(path):
    return api.route(path)
```

```python
# myapp/routes/todos.py
from myapp.wrappers.restx import route

@route("/todos")
class TodoList:
    def get(self): ...
    def post(self): ...
```

A [dependency stub](/guides/teach-a-dependency) points at that module:

```yaml
# suss/stubs/restx-wrapper.yaml
package: myapp.wrappers.restx
statements:
  - kind: re-exports
    of: flask_restx
```

The pack then accepts a `route` decorator imported from your wrapper alongside one imported from `flask_restx` itself. An aliased import (`from myapp.wrappers.restx import route as api_route`) resolves the same way. The pack hardcodes only what flask-restx defines. What you called your wrapper is your own choice, so it comes in through the stub.

`suss infer stub myapp` reads the project's own imports and drafts it, one file per wrapper module it finds. The fastapi pack reads the same `re-exports` statement, for a module of yours that re-exports FastAPI's own constructors.

A base class that comes from a gem is the Ruby equivalent:

```yaml
# suss/stubs/acme-graphql.yaml
package: acme-graphql
statements:
  - kind: extends-base
    class: Acme::GraphQL::AuthenticatedObject
    extends: Acme::GraphQL::BaseObject
```

`extends:` decides which pack receives the class. A graphql-ruby root class sends it to graphql-ruby, a Rails root class sends it to rails, and a class in neither list goes to both.

## What a file reads from the environment

Both adapters read config off the environment, and both follow it through a helper the project wrote. A Python project with a `setting()` helper:

```python
# shop/config.py
import os

def setting(name, default=None):
    return os.environ.get(name, default)
```

```python
# shop/main.py
@app.get("/health")
def health():
    return {"region": setting("SHOP_REGION"), "tier": setting("SHOP_TIER")}
```

```
shop/main.py
└─ GET /health  (fastapi handler | line 9 | confidence: low)
       -> 200 { region, tier }
         + shop/config.setting →
         + shop/config.setting →
         + reads runtime-config:python-env SHOP_REGION
         + reads runtime-config:python-env SHOP_TIER
```

The variable names come back on the route, not on the helper. suss reads Ruby the same way, through `ENV["X"]`, `ENV.fetch("X")` and a helper in front of either:

```
app/controllers/health_controller.rb
├─ GET /health  (rails handler | line 2 | confidence: low)
│      -> 200
│        + setting →
│        + setting →
│        + reads runtime-config:ruby-env SHOP_REGION
│        + reads runtime-config:ruby-env SHOP_TIER
```

`suss ask "what does app/controllers/health_controller.rb reach"` lists them for a file.

## What you do not get yet

- **Raw SQL is Python only.** A statement handed to SQLAlchemy's or SQLModel's `text("...")` is read for its kind and its table. A bare string handed to `session.execute` is not parsed, and Ruby has no raw-SQL reading at all.
- **Queue sends are not classified in either language.** The calls are recorded as invocation effects; nothing turns one into a channel the way the TypeScript packs do.
- **Plain Flask** (`@app.route`) has no pack yet.
- **graphql-ruby leaves some of the schema unread:** a `graphql_name` override, and interfaces, unions and enums.
- **Ruby's predicates are plain source text** rather than structured, so a condition reads back as it was written.
- **`suss corroborate` is TypeScript only.**

For more detail, read the package READMEs under `packages/adapter/python` and `packages/adapter/ruby`, and the one beside each pack under `packages/framework` and `packages/client`.
