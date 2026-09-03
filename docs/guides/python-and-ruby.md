# Read a Python or Ruby project

Point suss at a FastAPI service, a flask-restx service, or a
graphql-ruby schema and get the same summaries you would get from a
TypeScript project. Which route returns which status under which
condition, which service function each route calls, and which table
each query reads or writes. `check` and `inspect` read those summaries
the same way whatever language produced them, so a Python service and
a TypeScript client compare against each other in one run.

## What the two adapters read today

The Python adapter reads HTTP routes, through two packs. flask-restx
covers a `Resource` class decorated with `Namespace.route(path)`, and
FastAPI covers a function decorated with a verb-named method on an app
or a router. A route mounted through a shared framework package is
followed the whole way: through the app factory, through a loader class
the entry file hands over, and through the loop that mounts what the
loader returns. The Ruby adapter reads graphql-ruby's class-based
`field` DSL, one resolver per field, and the resolver method behind it,
found through the class ancestry whichever file declares it. It also
reads a Rails controller's own instance methods as actions, each bound
to the method and path `config/routes.rb` gives it.

Both adapters read bodies. Each return becomes a branch with its
status and the conditions that reach it, and the calls a body makes
become invocation effects with the conditions that gate each one. With
a storage pack composed in, a database call is classified: read or
write, which model, which rows it picks and which columns it asks for.
Python matches a query by what the method behind the call says it
returns, which reads through a project's own base class. A handler
that hands off to a service function reports the call, and the service
function's own summary reports the work, so a reach question follows
the call to find it. Ruby matches by what the receiver's class
inherits, which reads through `ApplicationRecord`.

## Let init find the project

`suss init` reads the dependency list a Python or Ruby project declares
and prints the commands for what it finds:

```bash
npx suss init services/shop
```

It reads `requirements.txt` and its includes, `pyproject.toml` (both
the standard table and Poetry's), `Pipfile`, `setup.cfg`, and
`Gemfile.lock`, and it says which pack goes with each library it
recognizes. Where it looked and could not read something, it says so.
A `setup.py` that computes its dependency list, a `Gemfile` with no
lock file beside it, and a submodule nobody checked out each get a
line, because a library that only appears in one of those is a pack
suss cannot suggest.

## Point extract at a Python project

```bash
npx suss extract --dir services/shop -f fastapi \
  -f flask-restx=suss.flask-restx.json -o summaries/shop.json
```

There is no tsconfig here, so point suss at the directory. It works out
that the directory is Python from what it contains: a `pyproject.toml`,
a requirements file, `setup.py`, `Pipfile`, or failing all of those,
the `.py` files themselves. The packs you ask for settle it too, since
nobody runs a Python pack over a TypeScript project. `--lang python`
lets you say so outright when you would rather not leave it to that:

```bash
npx suss extract --lang python --dir services/shop -f fastapi -o summaries/shop.json
```

Then read the file back:

```bash
npx suss inspect summaries/shop.json
npx suss check --dir summaries/
```

Over this repo's own `fixtures/python-webapp`, that starts:

```
myapp/behaviors.py
├─ GET /behaviors/{school_id}  (flask-restx handler | line 17 | confidence: low)
│
│      !! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here
│
└─ GET /behaviors/{school_id}/{behavior_id}  (flask-restx handler | line 23 | confidence: low)

       !! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here

myapp/exports.py
└─ GET ?  (flask-restx handler | line 14 | confidence: low)

       !! The router this route is declared on is mounted more than once, so the binding names no path and nothing pairs with it
       !! Nothing read this route's path, so its parameters name no role and a path parameter here does not read as one
       !! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here

myapp/fastapi_app.py
├─ GET /items/{item_id}  (fastapi handler | line 26 | confidence: low)
│      -> 200 TodoResponse
│
└─ POST /items  (fastapi handler | line 31 | confidence: low)
       -> 201 TodoResponse
```

The FastAPI routes come out with the status and the body type their
decorators declare. The flask-restx ones come out with the method and
the path, and say plainly that nothing was read from the body.
`/behaviors/{school_id}` is composed from the namespace the resource is
declared on and the path its own decorator writes, neither of which is
the whole path on its own.

The route in `exports.py` shows the other outcome. Its namespace is
mounted twice, so which path it is served under is not written down
anywhere, and the binding gives no path: `GET ?` pairs with nothing,
and each line under it says what nobody could read. A parameter's role
goes the same way, since the parameters the path mentions are what tell
a path parameter from a query parameter.

What the command reads, and from where:

- **The files.** Every `.py` file under the directory, skipping
  `__pycache__`, `.venv`, `venv`, `node_modules` and `.git`. Name files
  yourself with `--files` when you want a subset. A repository checked
  out inside the tree is left to that repository, unless this project's
  own `.gitmodules` lists it as a submodule, in which case suss treats
  its code as code this project imports and reads it that way.
- **What an absolute import resolves against.** The directory you
  pointed at, plus each checked-out submodule, which is the closest
  thing a Python project has to a tsconfig's `paths`. A submodule
  nobody checked out is reported: an import into an empty directory
  resolves to nothing, and the routes that depend on it would otherwise
  go missing with nothing said about it. A module found under two roots
  comes back ambiguous rather than resolved, because which one wins is a
  `sys.path` fact only a running interpreter has. With `-o`, the
  missing submodule is written to a note beside the summaries as well,
  so a CI job reading the summaries can tell the run was incomplete
  without watching stderr.
- **The packs.** Nothing else in the adapter knows a decorator name.

Summary paths come out relative to the directory you pointed at, so the
file is portable, and each summary is stamped with the format version.

Neither pack needs an installed Python, an interpreter, or a virtualenv.
Parsing is tree-sitter compiled to WASM and shipped in the package.

### Configuring a pack

Every built-in TypeScript pack needs nothing from you, because
everything it matches on is something its library defines. One of these
three wants a sentence about your project. Write it to a JSON file and
give the file name on the flag, which is how every pack takes
configuration:

```bash
npx suss extract --lang ruby --dir . -f graphql-ruby=suss.graphql-ruby.json
```

`suss.graphql-ruby.json` contains what the pack documents, and nothing
else reads it:

```json
{ "root": "app/graphql" }
```

A pack that cannot work without a value says so and stops, rather than
reading half a project quietly. Where an option gives a directory, a
relative path is read relative to the config file itself, so the same
file works whichever directory you run the command from.

A pack config says something about your own project. A fact about a
package you depend on, such as a module of yours that re-exports a
framework, goes in a [dependency stub](/dependency-stubs) instead.

You can still drive the adapters from a Node script, which is what to
do when you want something the CLI does not expose. `extractPythonProject`
and `findPythonFiles` come from `@suss/adapter-python`, and
`extractRubyProject` and `findRubyFiles` from `@suss/adapter-ruby`.

### Telling flask-restx about your own wrapper

Most services wrap flask-restx's route decorator in a module of their
own rather than importing it at every route file:

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

A [dependency stub](/dependency-stubs) points at that module:

```yaml
# suss/stubs/restx-wrapper.yaml
package: myapp.wrappers.restx
statements:
  - kind: re-exports
    of: flask_restx
```

The pack then accepts a `route` decorator imported from your wrapper
alongside one imported from `flask_restx` itself, which is always
accepted. The pack hardcodes only what flask-restx defines. Your
wrapper's name is your project's choice, so it arrives in the stub. An
aliased import (`from myapp.wrappers.restx import route as api_route`)
resolves the same way.

`suss infer stub myapp` reads the project's own imports and drafts
this stub, one file per wrapper module it finds, since the match above
is exact per module.

Each HTTP-verb-named method on the class becomes its own route, with
the verb from the method name and the path from the decorator's first
string argument. Werkzeug converters are canonicalized, so
`/orders/<int:order_id>` comes out as `/orders/{order_id}` with
`order_id` as a path parameter. A method with a return annotation gets
one transition describing that return type under a 200.
`@ns.marshal_with` and `@ns.expect` are not read yet.

A route declared on a namespace is served under the namespace's own
path, and the pack composes the two:

```python
from flask_restx import Namespace

ns = Namespace("orders", path="/orders")

@ns.route("/<int:order_id>")
class OrderDetail:
    def get(self, order_id): ...
```

with `api.add_namespace(ns)` somewhere in the files the run reads, that
route comes out as `/orders/{order_id}`. `@ns.route("")` is the
namespace's path by itself, `/orders`, and a path written `"/orders/"`
serves the same routes as `"/orders"`, because that is how the library
treats it. Parameters in the namespace's path are path parameters like
any others.

For the pack to compose the two, the namespace has to be constructed
with a literal `path` and mounted once, through a variable, by an
`add_namespace` that gives no `path` of its own. Written any other way,
the route is still discovered under its name, with no path and a
recorded reason, so it pairs with nothing rather than with whatever a
guessed path would have pointed at. `@suss/adapter-python`'s README has
the grid of what every spelling of a path means at each site, checked
against a running app.

### What FastAPI reads

The fastapi pack reads the same `re-exports` stub, for a module of
yours that re-exports FastAPI's own constructors, and most projects
never write one.

- The verb comes from the decorator's own attribute name, so
  `@app.post("/orders")` is a POST. The app or router is recognized by
  construction: `app = FastAPI()` or `router = APIRouter()`, one
  assignment back from an import of `fastapi`.
- `response_model=` and `status_code=` are taken as what the route
  declares. When neither is written, the return annotation supplies the
  response body. When a body was read and no status was written, the
  status is 200.
- A route on a router composes its path from the router's own `prefix`
  and the `prefix` at the `include_router(...)` call that mounts it,
  one hop deep, when both are string literals. So `/api/items/{item_id}`
  comes out whole even though no single file writes it.

Dependencies, middleware, and mounted sub-apps are not read yet.

## Point extract at a Ruby project

```bash
npx suss extract --dir . -f graphql-ruby=suss.graphql-ruby.json -o summaries/schema.json
```

```json
{ "root": "app/graphql" }
```

Add `-f activerecord=suss.activerecord.json` to classify the database
calls the resolver bodies make, with `{ "storageSystem": "postgresql" }`
in the config, since ActiveRecord talks to several databases and only
`database.yml` says which. The Python equivalent is
`-f sqlalchemy=suss.sqlalchemy.json`, added beside `fastapi` or
`flask-restx` the same way.

A `Gemfile`, a `Gemfile.lock`, or a Rails `config/application.rb` is
enough for suss to read the directory as Ruby, and `--lang ruby` lets
you say so outright. The walk reads every `.rb` file, skipping
`vendor`, `node_modules`, `tmp` and `.git`. Ruby constants resolve
through class and module nesting, and suss does not follow `require`,
so there is nothing here matching Python's import roots.

The pack takes two options:

| Option | Default | What it does |
|---|---|---|
| `root` | required | The directory a `mutation:` or `resolver:` reference resolves against, through Rails' constant-to-path convention. `Mutations::CampaignUpdate` is read from `<root>/mutations/campaign_update.rb`. Your layout is your project's, so there is no default, and the pack reads nothing without one. Written as a relative path, it is read relative to the config file it was written in. |
| `camelize` | `true` | graphql-ruby's schema-wide default for exposing a snake_case symbol camelCased. Set it to `false` when your schema does. A `field` or `argument` call's own `camelize:` keyword still wins for that one name, the same as it does at runtime. |

The base classes it reads are every type-level base `rails g
graphql:install` generates, the interface base included, and the
adapter follows a class's whole ancestry, so an intermediate base of
yours that leads to a generated one needs nothing said about it. A base
class that comes from a gem is one you add in a
[dependency stub](/dependency-stubs):

```yaml
# suss/stubs/acme-graphql.yaml
package: acme-graphql
statements:
  - kind: extends-base
    class: Acme::GraphQL::AuthenticatedObject
    extends: Acme::GraphQL::BaseObject
```

The pack then reads a class of yours that extends
`Acme::GraphQL::BaseObject` as a set of resolvers. `suss infer stub
acme-graphql` drafts this from the project's own `require`s and class
definitions; that read of `require` is only for the draft, not for
extraction itself.

A class extending one of those base classes has each `field` call in
its body turned into a resolver. The name is `Campaign.id`, from the
class's short name with a trailing `Type` stripped, which is
graphql-ruby's own default naming. The binding is
`graphql-resolver(typeName, fieldName)`, so it pairs against a client
operation exactly as a NestJS or Apollo resolver summary does.

`field :campaign_update, mutation: Mutations::CampaignUpdate` is
followed one hop: the referenced class's file is located under `root`,
and its own `field` and `argument` calls become the payload and the
arguments. An `argument` counts as required unless it says otherwise.

### What the rails pack reads

```bash
npx suss extract --dir . -f rails=suss.rails.json -o summaries/controllers.json
```

```json
{ "root": "app", "routesFile": "config/routes.rb" }
```

Every instance method a controller extending `ApplicationController`
defines directly is discovered as one of its actions. `config/routes.rb`
decides which method and path answer it: `resources`/`resource` with
`only:`/`except:`, `member`/`collection` blocks, one level of nested
resources, `namespace`, `scope module:`/`scope path:`, the bare
`get`/`post`/`patch`/`put`/`delete` calls with `to:` or the
`"path" => "controller#action"` spelling, and `root`. `mount`, `draw`,
`concern`, `constraints`, `match` and `direct` are left unread, and the
run records one gap saying so rather than guessing at them.

An action the routes file does not reach, a private helper a project
never routes, is still discovered, with its own calls followed into
whatever it calls, only with no boundary, the same way a method
nothing routes to but something calls still gets a summary. When the
routes file this run was pointed at does not exist at all, every
action named for one of Rails' seven conventional actions (`index`,
`show`, `new`, `create`, `edit`, `update`, `destroy`) is bound at the
path Rails' own naming convention gives it instead, and the run
records that it did so.

Compose `-f activerecord=suss.activerecord.json` the same way the
graphql-ruby example above does, to classify the database calls a
controller action's own calls make.

## Abstention is the design

Neither adapter guesses. A route whose path the source does not state
is still discovered, keeps its name, has no path, and records a gap
saying why:

```python
@app.get("/reports/" + REPORT_SECTION)
def report(): ...
```

That route pairs with nothing, which is the outcome you want. A guessed
path would point at some other team's handler, and every finding that
came back would be about a boundary that does not exist. The same
applies one level up, for a FastAPI router whose prefix is computed, or
one that is mounted twice, or mounted onto another router: the routes
on it keep their names and lose their paths.

Ruby abstains the same way per field. `field :status, status_label_for(:organizer)`
is discovered as `Organizer.status` with no declared contract at all,
rather than one that claims the type is unknown. When a `mutation:`
reference points at a file that is not where the convention says it
should be, you get the field and no payload.

This is what makes the modest name resolver enough. It classifies a
name as a parameter, a local, an import, or "cannot tell", and because
the last one is a legal answer everywhere it is read, the resolver only
has to avoid being wrong. It never has to be complete.

## What you do not get yet

- **Raw SQL stays unread.** A string handed to `session.execute` is
  not parsed, so a unit doing its database work that way reports the
  call and nothing about what the query says.
- **Queue sends and config reads are not classified.** The calls are
  recorded as invocation effects; nothing turns one into a channel or
  a config key the way the TypeScript packs do.
- **Plain Flask** (`@app.route`) has no pack yet.
- **Ruby reads graphql-ruby and Rails.** A `graphql_name` override, and
  interfaces, unions and enums, are unread on the GraphQL side; `mount`,
  `draw`, `concern`, `constraints`, `match` and `direct` are unread in
  `routes.rb`; and Ruby's predicates are plain source text rather than
  structured.
- **`suss corroborate` is TypeScript only.**

For what each package does in more detail, read the package READMEs:
`packages/adapter/python`, `packages/adapter/ruby`, and the packs
under `packages/framework`, `sqlalchemy`, `activerecord` and `rails`
among them.
