# Read a Python or Ruby project

suss reads Python and Ruby through two language adapters, and
`suss extract` reaches both. Everything downstream is unchanged,
because a summary carries a boundary binding whatever language it came
from, so `suss check` and `suss inspect` read a Python project's
summaries exactly as they read a TypeScript project's.

## What the two adapters read today

The Python adapter reads HTTP routes, through two packs. flask-restx
covers a `Resource` class decorated with `Namespace.route(path)`, and
FastAPI covers a function decorated with a verb-named method on an app
or a router. The Ruby adapter reads graphql-ruby's class-based `field`
DSL, one resolver per field.

Both are early. Neither adapter reads a method body, so every summary
comes out with no branches and its confidence pinned low. What you get
is which boundaries exist and what each one declares, which is enough
to pair a Python route against the TypeScript client that calls it, or
a graphql-ruby field against a query your frontend sends.

## Let init find the project

`suss init` reads the dependency list a Python or Ruby project states
and prints the commands for what it finds:

```bash
npx suss init services/shop
```

It reads `requirements.txt` and its includes, `pyproject.toml` (both
the standard table and Poetry's), `Pipfile`, `setup.cfg`, and
`Gemfile.lock`, and names the pack for each library it recognizes.
Where it looked and could not read something, it says so: a `setup.py`
that computes its dependency list, a `Gemfile` with no lock file
beside it, and a submodule nobody checked out each get a line, because
a library named only in one of those is a pack suss cannot suggest.

## Point extract at a Python project

```bash
npx suss extract --dir services/shop -f fastapi \
  -f flask-restx=suss.flask-restx.json -o summaries/shop.json
```

There is no tsconfig here, so point suss at the directory. It works out
that the directory is Python from what it holds: a `pyproject.toml`, a
requirements file, `setup.py`, `Pipfile`, or failing all of those, the
`.py` files themselves. The packs you name settle it too, since nobody
asks for a Python pack over a TypeScript project. `--lang python` says
it outright when you would rather not leave it to that:

```bash
npx suss extract --lang python --dir services/shop -f fastapi -o summaries/shop.json
```

Then read the file back:

```bash
npx suss inspect summaries/shop.json
npx suss check --dir summaries/
```

Over this repo's own `fixtures/python-webapp`, that prints:

```
myapp/fastapi_app.py
├─ GET /items/{item_id}  (fastapi handler | line 26 | confidence: low)
│      -> 200 TodoResponse
│
└─ POST /items  (fastapi handler | line 31 | confidence: low)
       -> 201 TodoResponse

myapp/routes/todos.py
├─ GET /todos  (flask-restx handler | line 6 | confidence: low)
│
│      !! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here
```

The FastAPI routes carry the status and shape their decorators declare.
The flask-restx ones carry the method and path, and say plainly that
nothing was read from the body.

What the command reads, and from where:

- **The files.** Every `.py` file under the directory, skipping
  `__pycache__`, `.venv`, `venv`, `node_modules` and `.git`. Name files
  yourself with `--files` when you want a subset. A repository checked
  out inside the tree is left to that repository, unless this project's
  own `.gitmodules` names it as a submodule, in which case its code is
  code this project imports and is read as such.
- **What an absolute import resolves against.** The directory you
  pointed at, plus each checked-out submodule, which is the closest
  thing a Python project has to a tsconfig's `paths`. A submodule
  nobody checked out is reported: an import into an empty directory
  resolves to nothing, and the routes that depend on it would otherwise
  go quietly missing. A module found under two roots comes back
  ambiguous rather than resolved, because which one wins is a
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
everything it matches on is something its library defines. Two of these
three want a sentence about your project. Write it to a JSON file and
name the file on the flag, which is how every pack takes configuration:

```bash
npx suss extract --dir services/shop -f flask-restx=suss.flask-restx.json
```

`suss.flask-restx.json` holds what the pack documents, and nothing else
reads it:

```json
{ "wrapperModules": ["myapp.wrappers.restx"] }
```

A pack that cannot work without a value says so and stops, rather than
reading half a project quietly. Where an option names a directory, a
relative path is read relative to the config file itself, so the same
file works whichever directory you run the command from.

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

`wrapperModules: ["myapp.wrappers.restx"]` names that module, and the
pack accepts a `route` decorator imported from it alongside one
imported from `flask_restx` itself, which is always accepted. The pack
hardcodes only what flask-restx defines; your wrapper's name is your
project's choice, so it arrives as configuration. An aliased import
(`from myapp.wrappers.restx import route as api_route`) resolves the
same way.

Each HTTP-verb-named method on the class becomes its own route, with
the verb from the method name and the path from the decorator's first
string argument. Werkzeug converters are canonicalized, so
`/orders/<int:order_id>` reads as `/orders/{order_id}` with
`order_id` as a path parameter. A method with a return annotation gets
one transition describing that shape under a 200. `@ns.marshal_with`
and `@ns.expect` are not read yet.

### What FastAPI reads

`fastapiFramework()` takes the same `wrapperModules` option, for a
module that re-exports FastAPI's own constructors, and most projects
need none of it.

- The verb comes from the decorator's own attribute name, so
  `@app.post("/orders")` is a POST. The app or router is recognized by
  construction: `app = FastAPI()` or `router = APIRouter()`, one
  assignment back from an import of `fastapi`.
- `response_model=` and `status_code=` are read as what the route
  declares. When neither is written, a return annotation supplies the
  shape. When a shape was read and no status was written, the status is
  200.
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

A `Gemfile`, a `Gemfile.lock`, or a Rails `config/application.rb` is
enough for suss to read the directory as Ruby, and `--lang ruby` says
so outright. The walk takes every `.rb` file, skipping `vendor`,
`node_modules`, `tmp` and `.git`. Ruby constants resolve through class
and module nesting and `require` is not followed, so there is nothing
here matching Python's import roots.

The pack takes three options:

| Option | Default | What it does |
|---|---|---|
| `root` | required | The directory a `mutation:` or `resolver:` reference resolves against, through Rails' constant-to-path convention. `Mutations::CampaignUpdate` is read from `<root>/mutations/campaign_update.rb`. Your layout is your project's, so there is no default, and the pack reads nothing without one. Written relative, it is read relative to the config file it was written in. |
| `baseClassNames` | `["Types::BaseObject"]` | Names a project's own intermediate base class. What you pass is added to graphql-ruby's own generated base, not swapped for it. |
| `camelize` | `true` | graphql-ruby's schema-wide default for exposing a snake_case symbol camelCased. Set it to `false` when your schema does. A `field` or `argument` call's own `camelize:` keyword still wins for that one name, the same as it does at runtime. |

A class extending one of those base classes has each `field` call in
its body read as a resolver. The name is `Campaign.id`, from the
class's short name with a trailing `Type` stripped, which is
graphql-ruby's own default naming. The binding is
`graphql-resolver(typeName, fieldName)`, so it pairs against a client
operation exactly as a NestJS or Apollo resolver summary does.

`field :campaign_update, mutation: Mutations::CampaignUpdate` is
followed one hop: the referenced class's file is located under `root`,
and its own `field` and `argument` calls become the payload and the
arguments. An `argument` counts as required unless it says otherwise.

Rails routes are out of scope. `routes.rb` expands macros in a way that
needs its own reader, and that reader does not exist yet.

## Abstention is the design

Neither adapter guesses. A route whose path the source does not state
is still discovered, keeps its name, carries no path, and records a gap
saying why:

```python
@app.get("/reports/" + REPORT_SECTION)
def report(): ...
```

That route pairs with nothing, which is the outcome you want. A guessed
path would name some other team's handler, and every finding that came
back would be about a boundary that does not exist. The same holds one
level up, for a FastAPI router whose prefix is computed, or one that is
mounted twice, or mounted onto another router: the routes on it keep
their names and lose their paths.

Ruby abstains the same way per field. `field :status, status_label_for(:organizer)`
is discovered as `Organizer.status` with no declared contract at all,
rather than one that claims the type is unknown. A `mutation:`
reference whose file is not where the convention says produces the
field and no payload.

This is what makes the modest name resolver enough. It classifies a
name as a parameter, a local, an import, or "cannot tell", and because
the last one is a legal answer everywhere it is read, the resolver only
has to avoid being wrong. It never has to be complete.

## What you do not get yet

- **No behavior.** Both adapters read declarations. A route's
  transitions are empty, or one transition stating a declared shape.
  Every summary's confidence is pinned low to say so.
- **No effects.** A Python or Ruby unit records no storage call, no
  queue send, no config read.
- **Python discovery is top-level only.** A definition or an import
  nested inside `if`, `try` or `with` is not bound, and a route
  registered inside an app-factory function is not discovered.
- **Plain Flask** (`@app.route`) has no pack yet.
- **Ruby reads graphql-ruby only.** A `def resolve` body, a
  `graphql_name` override, and interfaces, unions and enums are all
  unread.
- **`suss corroborate` is TypeScript only.**

For what each package does in more detail, read the package READMEs:
`packages/adapter/python`, `packages/adapter/ruby`, and the three packs
under `packages/framework`.
