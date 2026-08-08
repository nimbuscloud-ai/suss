# Read a Python or Ruby project

suss reads Python and Ruby through two language adapters, which you
call from a small Node script. `suss extract` cannot reach them yet;
the CLI is TypeScript and JavaScript only. Everything downstream is
unchanged, because a summary carries a boundary binding whatever
language it came from. `suss check` and `suss inspect` read the file
the script writes exactly as they read one the CLI wrote.

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

## Point a script at a Python project

```ts
import fs from "node:fs";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { SUMMARY_SCHEMA_VERSION } from "@suss/behavioral-ir";
import { fastapiFramework } from "@suss/framework-fastapi";
import { flaskRestxFramework } from "@suss/framework-flask-restx";

const root = "/repo/services/shop";

const { summaries } = await extractPythonProject({
  files: findPythonFiles(root),
  packs: [
    flaskRestxFramework({ wrapperModules: ["myapp.wrappers.restx"] }),
    fastapiFramework(),
  ],
  roots: [root],
  workspaceRoot: "/repo",
});

for (const summary of summaries) {
  summary.schemaVersion = SUMMARY_SCHEMA_VERSION;
}

fs.writeFileSync("summaries/shop.json", JSON.stringify(summaries, null, 2));
```

`SUMMARY_SCHEMA_VERSION` comes from `@suss/behavioral-ir`. Stamping it
is what `suss extract` does on its way out, and it saves a later reader
treating the file as one written before the field existed.

Then read the file back with the CLI:

```bash
npx suss inspect summaries/shop.json
npx suss check --dir summaries/
```

Over this repo's own `fixtures/python-webapp`, that prints:

```
fixtures/python-webapp/myapp/fastapi_app.py
├─ GET /items/{item_id}  (fastapi handler | line 708 | confidence: low)
│      -> 200 TodoResponse
│
└─ POST /items  (fastapi handler | line 839 | confidence: low)
       -> 201 TodoResponse

fixtures/python-webapp/myapp/routes/todos.py
├─ GET /todos  (flask-restx handler | line 78 | confidence: low)
│
│      !! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here
```

The FastAPI routes carry the status and shape their decorators declare.
The flask-restx ones carry the method and path, and say plainly that
nothing was read from the body.

Both line numbers in that block are wrong, and they are printed here as
the command printed them. A Python summary records a byte offset where
`inspect` reads a line number, so `line 708` points past the end of a
32-line file and `line 78` lands in the middle of a token in a 10-line
one. Tracked as
[#215](https://github.com/nimbuscloud-ai/suss/issues/215). Until it is
fixed, find the route by its method and path rather than by the number.

The four options:

- **`files`** is every file to parse, as absolute paths. `findPythonFiles(root)`
  walks a directory for `.py` files and skips `__pycache__`, `.venv`,
  `venv`, `node_modules` and `.git`.
- **`roots`** is what an absolute import resolves against, the closest
  thing a Python project has to a tsconfig's `paths`. A module found
  under two roots comes back ambiguous rather than resolved, because
  which one wins is a `sys.path` fact only a running interpreter has.
- **`workspaceRoot`** shortens each summary's `location.file` to a
  repo-relative path, the way `suss extract` writes them. Leave it off
  and the paths stay absolute.
- **`packs`** is which libraries to look for. Nothing else in the
  adapter knows a decorator name.

Neither pack needs an installed Python, an interpreter, or a virtualenv.
Parsing is tree-sitter compiled to WASM and shipped in the package.

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

## Point a script at a Ruby project

```ts
import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { graphqlRubyFramework } from "@suss/framework-graphql-ruby";

const graphqlRoot = "/repo/app/graphql";

const { summaries } = await extractRubyProject({
  files: findRubyFiles(graphqlRoot),
  packs: [graphqlRubyFramework({ root: graphqlRoot })],
  workspaceRoot: "/repo",
});
```

`findRubyFiles` walks for `.rb` files and skips `vendor`,
`node_modules`, `tmp` and `.git`. There is no `roots` option here: Ruby
constants resolve through class and module nesting, and `require` is
not followed.

The pack takes three options:

| Option | Default | What it does |
|---|---|---|
| `root` | required | The directory a `mutation:` or `resolver:` reference resolves against, through Rails' constant-to-path convention. `Mutations::CampaignUpdate` is read from `<root>/mutations/campaign_update.rb`. Your layout is your project's, so there is no default. |
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
