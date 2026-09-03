# @suss/adapter-python

The Python language adapter for suss. It parses source with tree-sitter (WASM), resolves names with its own lexical binder, and emits behavioral structure through the same shared assembly layer the TypeScript adapter uses.

## What this package is

`@suss/adapter-python` is the Python language adapter. It meets the Layer 1 contract in [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md): discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Python grammar (`grammar/tree-sitter-python.wasm`, so there is no native build step), builds module, class and function scopes over the tree (imports, assignments, `global`/`nonlocal`), works out which file in the repo an import points at, and finds routes on decorated functions and class methods whose decorator resolves to a module the pack was configured with. When a pack says the library mounts routers (FastAPI's `APIRouter` plus `include_router`), the adapter builds a route's path out of the two literal prefixes, one mount hop deep. When it cannot build the path, the route keeps its name, gets no path, and gets a gap explaining why. Each unit it finds becomes a `RawCodeStructure` object, which it hands to `assembleSummary` in `@suss/extractor`, the same assembly code the TypeScript adapter uses.

v0 (this slice) does nothing with the path engine. A route either has no transitions at all, or one transition that describes the response the code declares (a FastAPI `response_model` / `status_code`, or a return annotation). It never breaks a route into branches. See [`design/proposals/language-adapters.md`](../../../design/proposals/language-adapters.md) for what a later slice adds.

## Where it fits in suss

This package depends on `@suss/extractor` (for `RawCodeStructure` and `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (`@suss/framework-flask-restx`, `@suss/framework-fastapi`) use its `PythonPack` contract. Nothing in this package knows what any particular library calls its decorators.

## Path templates

A pack declares which syntax its library uses for path parameters, under `pathParamSyntax`. The adapter understands two. `"braces"` covers `{name}` and `{name:converter}`, which is what FastAPI uses via Starlette. `"flaskConverters"` covers `<name>`, `<converter:name>`, and `<converter(arguments):name>`, which is what flask-restx uses via Werkzeug. In both cases the adapter rewrites the path into the IR's plain-brace form and treats the parameters in the template as path parameters.

If a pack declares nothing, it gets paths exactly as written and no parameter is treated as a path parameter. If a pack declares a syntax the adapter has no reader for, its routes are still discovered, but they come out with no path and a recorded gap. Packs written against 0.3 assumed brace parsing applied to every path, so those packs now have to declare `"braces"` explicitly.

## Which expression is the app

A route is a decorator on something, and whether it counts depends on what that something is. `@app.get("/x")` is a route when `app` was built by calling what FastAPI exports, and nothing at all when `app` is some other object with a `get` method. So discovery has to answer one question per decorator: what built the object this hangs on?

The lexical binder goes first, and it settles most cases: it follows the name one hop back to the call that built it and reads where that call's constructor was imported from. It is fast, it needs no facts, and it covers the module-level app and the app factory.

The binder only records a name written directly in a body's own statement list, and it has no idea what an attribute refers to. So these two get nothing out of it:

```python
class Holder:
    def __init__(self):
        self.app = FastAPI()

    def wire(self):
        @self.app.get("/health")     # the binder has no binding for self.app
        def health(): ...

try:
    app = FastAPI()

    @app.get("/health")              # the binder skips a name written inside a try
    def health(): ...
except RuntimeError:
    pass
```

Whatever the binder declines goes to the rules in `@suss/resolution`, as `wantedSubject`. They follow the value however it was moved, through a binding, a property read, an import, or an argument, and come back with the call it was written as and where that call's callee came from. The TypeScript adapter asks the same question of the same rules, so a spelling either language learns to follow, both get.

The rules settle on one construction or on nothing. A name that could be two different constructions comes back with neither, because keying a route on the wrong app is worse than keying it on none, and then the decorator stays unclassified and the route is not discovered.

Three Python facts feed the question. A method's receiver binds to the class it is declared in, which is what makes `self.app` the value the class puts under `app`. An assignment written inside a method body binds its name, which the class walk used to skip. And an import of a package the repo cannot read still records which module a name came from, which is how `FastAPI()` is told apart from a same-named constructor the project wrote itself.

## How a prefix is read

A mounted route's path comes from prefixes written at up to four places: the object the mount is called on, whatever that object was built from, the router's constructor, and the call that mounts it. All four go through one reader, and a given spelling means the same thing at every one of them. We got this wrong three times by fixing one place or one spelling at a time, so the whole grid is written out here.

Every cell describes what the library itself does. We read that off the library's source and then confirmed it against a running app, using `url_map` for flask-restx and the route table for FastAPI.

**At the constructor** (`Namespace(path=...)`, `APIRouter(prefix=...)`):

| Written              | flask-restx serves         | FastAPI serves             | What suss records                                                            |
| -------------------- | -------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| nothing              | `/` + the namespace's name | the route path, no prefix  | unstated                                                                     |
| `"/orders"`          | `/orders` + the route path | `/orders` + the route path | stated                                                                       |
| `"/orders/"`         | `/orders` + the route path | the app does not start     | stated, trailing slashes trimmed where the pack says so                      |
| `"/"`                | the route path, no prefix  | the app does not start     | stated, and trimming leaves nothing                                          |
| `""`                 | `/` + the namespace's name | the route path, no prefix  | unstated where the pack says a no-value prefix is unstated, otherwise stated |
| `None`, `False`, `0` | `/` + the namespace's name | the app does not start     | unstated where the pack says so, otherwise unreadable                        |
| a name or a call     | whatever it evaluates to   | whatever it evaluates to   | unreadable                                                                   |

**At the mount** (`add_namespace(ns, path=...)`, `include_router(router, prefix=...)`):

| Written              | flask-restx serves                                   | FastAPI serves                                     | What suss records                                     |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| nothing              | where the constructor put it                         | the constructor's prefix + the route path          | unstated                                              |
| `"/api"`             | `/api` + the route path, replacing the constructor's | `/api` + the constructor's prefix + the route path | stated                                                |
| `"/api/"`            | `/api/` + the route path, kept as written            | the app does not start                             | stated                                                |
| `""`                 | where the constructor put it                         | the constructor's prefix + the route path          | unstated where the pack says so, otherwise stated     |
| `None`, `False`, `0` | where the constructor put it                         | the app does not start                             | unstated where the pack says so, otherwise unreadable |
| a name or a call     | whatever it evaluates to                             | whatever it evaluates to                           | unreadable                                            |

The two libraries differ on one property, and the pack says which way each one goes. flask-restx checks whether the path is truthy, so all four no-value spellings mean the same thing as writing nothing, at both places. FastAPI wants a string, so an empty string is an ordinary prefix that happens to add nothing, and the other three stop the app from starting.

Here is what the reader does with each answer. A stated prefix goes into the path. An unstated one adds nothing, unless the pack says the library makes up a path of its own when the prefix is unstated. In that case the route abstains, because the path it is actually served at is somewhere suss never looked. An unreadable prefix abstains too. A route that abstains keeps its name and gives no path, and the summary says why.

The trailing-slash rows are not symmetric. flask-restx trims at the constructor and not at the mount, because only the constructor's path goes through the property that strips it. The pack declares trimming per library, and the mount side does not need it, since a mount that states a prefix on that library abstains anyway.

### The object the mount is called on

flask-restx serves a route under the prefix of the object `add_namespace` was called on, ahead of everything the namespace and the route say. That object has two prefixes of its own: one written on it, `Api(prefix=...)`, and one written on the Flask blueprint it was built from, `Blueprint(name, __name__, url_prefix=...)`. The library joins the blueprint's prefix, the `Api`'s, the namespace's path and the route's path by concatenating them and dropping the falsy ones, so nothing is stripped at either of these two sites.

FastAPI has no column here: its app has no prefix of its own, and the pack declares none, so the object contributes nothing.

**At the blueprint** (`Blueprint("api", __name__, url_prefix=...)`):

| Written | flask-restx serves | The reader says |
| --- | --- | --- |
| nothing | the rest of the path, no prefix | unstated |
| `"/api/v1"` | `/api/v1` + the rest | stated |
| `"/api/v1/"` | `/api/v1/` + the rest, and Werkzeug answers the merged `/api/v1/...` | stated, and the composed path is merged |
| `"/"` | the rest of the path, once the merge collapses the doubled slash | stated, and merging leaves nothing |
| `""`, `None` | the rest of the path, no prefix | unstated |
| `False`, `0` | the app does not start: Flask hands the value straight to `rstrip` | unstated |
| a name or a call | whatever it evaluates to | unreadable |

**At the `Api`** (`Api(bp, prefix=...)`):

| Written | flask-restx serves | The reader says |
| --- | --- | --- |
| nothing | the blueprint's prefix + the rest | unstated |
| `"/extra"` | the blueprint's prefix + `/extra` + the rest | stated |
| `"/extra/"` | the same, concatenated as written, and Werkzeug answers the merged path | stated, and the composed path is merged |
| `""`, `None`, `False`, `0` | the blueprint's prefix + the rest | unstated |
| a name or a call | whatever it evaluates to | unreadable |

### A call that spreads a dictionary

`Api(**build_authorizations())` and `include_router(router, **options)`
spread a value the call does not write out. The reader skips the spread
and reads the keywords that are written, so the routes underneath keep
their paths.

That leaves one thing it cannot see. If the dictionary sets the prefix
keyword itself, the composed path is wrong, and nothing in the output
says so. Reading the prefix as unknown instead would be correct and would
cost every route under every call that spreads a config dictionary, which
is most of them. Propagating the uncertainty rather than choosing between
the two is the work that would settle this.

**At the registration** (`app.register_blueprint(bp, ...)`), which the reader consults only to abstain:

| Written | flask-restx serves | The reader says |
| --- | --- | --- |
| nothing | where the blueprint's own `url_prefix` put it | the reading stands |
| `url_prefix="/over"` | `/over` + the rest, replacing the blueprint's | abstain |
| `url_prefix=""` | the rest, replacing the blueprint's with nothing | abstain |
| `url_prefix=None` | where the blueprint's own `url_prefix` put it | abstain |
| registered on another blueprint | the outer blueprint's prefix in front of everything | abstain |
| registered twice | flask-restx refuses to start | abstain |
| never registered | nothing at all | the reading stands |

Any spelling of `url_prefix` at the registration abstains, `None` included. The three that are written say different things (`"/over"` replaces, `""` replaces with nothing, `None` falls back to the blueprint's own), so a written keyword there says nothing on its own about where the routes land.

A registration nobody wrote leaves the reading standing rather than abstaining. A blueprint the run never sees registered is one whose registration might sit in a file outside the run, and reading the prefix it was built with is the same claim the constructor already makes.

### Repeated slashes

A prefix written with a trailing slash leaves the composed path with two. Werkzeug answers such a rule at the merged path and redirects the written one, so `/api/v1//orders` is reached at `/api/v1/orders`; the pack says so, and the reader merges repeated slashes in every path it composes. Starlette does not do this, so FastAPI's pack says nothing and its paths stand as composed.

## What a body lowers to

A route's own returns are what make it produce more than one transition, so the
adapter lowers a function body into the statement form the shared path engine
in `@suss/extractor` walks. That engine is generic over the language's own
condition handle and never looks inside one, so the enumeration, the negation
of an earlier arm, and the budget are all shared with TypeScript.

| Python | Lowers to |
| --- | --- |
| `if` / `elif` / `else` | one `if` per test, with the elif chain nested into the else arm the way Python reads it |
| `while`, `for` | `loop` |
| `try` / `except` / `finally` | `try`, with every except arm as the catch body |
| `match` / `case` | `switch`, one group per case, `case _` as the default group |
| `return`, `raise` | `exit`, which is what gives each return its own transition |
| `break`, `continue` | `exit`, which the engine uses for reachability rather than as an outcome |
| anything else | `opaque` |

A statement's exit kind comes from scanning its own subtree for a return or a
raise, stopping at a nested `def` or `lambda`, because those belong to the
function they declare. A raise anywhere beats a return anywhere.

So a handler written this way:

```python
def get(self, order_id) -> dict:
    if not found:
        return {"error": "nope"}, 404
    return {"a": 1}, 200
```

comes out as two transitions, the 404 gated on the opaque condition
`not found` and the 200 gated on its negation, rather than as one claim with a
guessed status.

### Keying anything on a node

tree-sitter hands back a fresh wrapper object every time a child is read, so
two reads of one node are never `===` and a plain `Set` or `Map` keyed on a
node matches nothing. Use `NodeSet` and `NodeMap`, which key on the node id.
`npm run check:style` fails a build that keys either on a node.

## What a body does with the database

A pack says which query types its library defines, and a call chain matches
when the method behind it says it returns one:

```ts
storage: [
  {
    module: "sqlalchemy.orm",
    queryTypes: ["Query"],
    writes: ["update", "delete", "add"],
    storageSystem: "postgresql",
  },
]
```

Matching on the return rather than on the import is what reads a project's own
wrapper. A measured Flask service imports `sqlalchemy` in 50 files, and every
one of its 157 queries still goes through a base class the call sites never
import:

```python
# in the project, not in the library
class Base:
    @classmethod
    def query(cls) -> Query: ...

class Orders(Base): ...

# in a handler, importing neither the base nor SQLAlchemy
found = Orders.query().filter_by(id=1).first()
```

A recognizer keyed on the import finds none of that. Following the call to
`Base.query` and reading what it says it returns finds all of it, and the
inheritance hop comes from `contains`, which reads `holdsProperty` and adds
what a base class declares.

A chain is one thing the code does, so the three calls above are one read. The
call that starts the chain is the one resolved, and the method the chain ends
with tells a read from a write. A method a base and a subclass both declare
gives two, and nothing is claimed.

A query built from a function the library exports has no project method in
between for its return to be read off, so a pack lists those by name and a call
site importing one matches on that:

```ts
queryFunctions: ["select", "insert", "update", "delete"]
```

`fields` comes from the columns a query names, `User.id` in
`select(User.id, User.email)`. `selector` comes from the keywords the chain
picks rows by, `id` in `filter_by(id=user_id)`, gathered from every call in
the chain rather than only the last. Raw SQL handed to `execute` is not read
at all.

## Where a mount is written

Almost no service mounts anything at the top level of a module. It builds its routers or namespaces there, each with a literal prefix, and registers them inside the function that builds the app, often by looping over a list that another function put together:

```python
def create_app():
    app = Flask(__name__)
    api = Api(app)
    for namespace in loader.load_namespaces():
        api.add_namespace(namespace)
    return app
```

So suss looks for mounts inside function bodies as well as at the top level. It still reads constructor calls at the top level only, which is where people write them. It does not see a mount inside an `if`, a `try`, a `with`, a `while`, or a class method, because the binder records no name written inside one of those, and a mount there would resolve to nothing anyway.

A mount inside a `for` goes one of two ways, depending on whether the source says which routers the loop covers.

| The loop reads | What suss does | Why |
| --- | --- | --- |
| a list or tuple of bare names, `for ns in [orders, users]` | mounts each of those names, exactly as a mount call that named it would | every element is a name the existing one-hop rule already follows |
| anything else, `for ns in loader.load_namespaces()` | mounts nothing, and every router it never saw mounted by name explains that the loop is the reason | no file says which routers the call returns |

Claiming a path off the second row would mean guessing twice at once: that this router is in the collection at all, and that the mount states no prefix that would replace or extend the router's own. A wrong path is worse than no path here, because a claimed path pairs the route with a contract on the other side, and every check downstream treats it as fact. Nothing tells those checks apart from a path suss followed all the way.

What the second row does give you is a better explanation. A router nobody mounts by name used to say "is never mounted through a single variable binding in the files read", which sends a reader hunting for a registration that is sitting right there in the app factory. When suss saw a loop it could not enumerate, the reason says that instead, and the fix it points at (list the routers out in the source, or give suss the list) is the one that works.

Both rows were checked against a running app. A loop over a literal list serves each namespace under its constructor path, the same paths the direct mounts serve. A `path=` written on the mount inside the loop replaces every namespace's own path, which is one more reason not to treat a loop's mount as an ordinary registration.

### A mount inside a function runs only if the app calls that function

A mount at a module's top level runs on import, so it is the mount. A mount inside a function is only a candidate, and suss has no idea which functions the app actually calls. A repo with a test factory next to the app factory is where that goes wrong:

```python
def create_test_app():
    app = FastAPI()
    app.include_router(router, prefix="/test")   # only tests call this
    return app


def create_app():
    app = FastAPI()
    for r in loader.load_routers():              # what production runs
        app.include_router(r)
    return app
```

Taking the only mount it could follow would put the route at `/test`, where no request ever arrives. So suss drops a mount written inside a function when it also saw a loop it could not enumerate somewhere other than that same function. The route abstains, and says both the function and the loop.

Both of those qualifiers matter. Only counting loops keeps the ordinary case working: two factories that each register their own routers by name are not competing, because neither one could have registered the other's. Only counting a loop in a *different* place keeps a factory working when it mixes an explicit registration with a loop, since both of those run together whenever that function runs.

A module-level mount is never dropped this way. It runs whichever factory the app calls. flask-restx trims at the constructor and not at the mount, because only the constructor's path goes through the property that strips it. The pack declares trimming per library, and the mount side does not need it, since a mount that states a prefix on that library abstains anyway.

## What a file reads from the environment

`os.environ` is part of the language's standard library, so the adapter recognizes reads of it itself, without a pack. Each read becomes the same `config-read` interaction the TypeScript adapter emits for `process.env.X`, on the binding `runtime-config`, spelled `os.environ["X"]` whichever way the source wrote it. The runtime-config checker pairs those against what a template declares for the function the file runs in.

| Python | Recognized as | Defaulted |
| --- | --- | --- |
| `os.environ["X"]` | a read of `X` | no |
| `os.environ.get("X")` | a read of `X` | no |
| `os.environ.get("X", "d")`, `os.environ.get("X", default="d")` | a read of `X` | yes |
| `os.getenv("X")`, `os.getenv("X", "d")` | a read of `X` | as above |
| any of these followed by `or` (`os.environ.get("X") or "d"`) | a read of `X` | yes |
| `import os as _os`, `from os import environ, getenv` | the same reads, through the alias | |
| `os.environ[name]`, `os.environ.get(f"{prefix}_X")` | nothing: the name is not a literal | |
| `os.environ["X"] = "1"`, `del os.environ["X"]`, `"X" in os.environ` | nothing: a write or a membership test | |
| `os.environ.get("X") or os.environ.get("Y")` | `X` defaulted, `Y` not, since `Y` is the chain's last resort | |

A read inside a route body goes on that route's summary. A read at module level, or in a class body, runs when the module is imported, so it goes on a `module-init` summary named after the file, one per file that has such a read. A read inside a function a route reaches through its calls goes on that function's own summary (see below). A read inside a function nothing discovered and nothing reaches is reported nowhere, because nothing says when that function runs.

## What a route reaches

A route's body calls project functions, and those call others. Each function a route reaches this way gets a summary of its own, of kind `library`, bound as `function-call` with `transport: "in-process"` and `recognition: "reachable"`, with the calls, environment reads and database work its own body does. Each invocation effect on a route or a reached function says which summary the call lands on, in `summary`, so a reader answering "what does this route reach" follows `summary` from one unit to the next and never has to match a name. This is the same walk the TypeScript adapter runs, and it produces the same shape.

The walk starts at every discovered route, and adds a `calls` fact for each call in a body it could follow, until the set stops growing. A function two routes both reach gets one summary. A call the walk could not follow is recorded once per callee on the summary of the body it is in, as an `unfollowedCall` gap saying why, unless the reason is one nothing could have done better with (a call to a parameter that some caller passes a function by name into, or a call into a package that is not in the run).

A callee is followed only through a binding that says where it came from. The binder's scopes settle a name written in the file; the import resolver settles a name brought in from another file in the run.

| Written as | Followed to |
| --- | --- |
| `helper()` with `def helper` in the file | that definition |
| `helper()` with `from pkg.mod import helper` | `helper` in `pkg/mod.py` |
| `mod.helper()` with `import pkg.mod` or `from pkg import mod` | `helper` in `pkg/mod.py`, whether or not `pkg` has an `__init__.py` |
| `run = helper` then `run()`, written straight in a body | `helper`, one alias hop |
| `Handlers.on_get()` with `on_get = helper` in the class body | `helper` |
| `self.method()` or `cls.method()` inside a method | the method on the enclosing class |
| `Service().run()`, or `svc = Service()` then `svc.run()` | `run` on `Service` |
| `Service()` | `Service.__init__` |
| `helper()` with `from pkg.mod import *` and one module defining it | that definition |
| a call written as an argument, or as the receiver of a chain | followed like any other, in the order it finishes |
| a call inside a lambda | the enclosing function's call |
| `inner()` with `def inner` nested in the body | `inner`, which gets a summary of its own with the calls its body makes |
| `register(build_index)`, where `register(handler)` calls `handler()` | `build_index`, followed from wherever a caller in the run named it, through the parameter `register`'s own body calls |

A function passed by name into a call is followed one hop further than the call itself. `register(build_index)` records where `build_index` is declared, keyed to its position among `register`'s arguments; `register`'s own body calling `handler()` records which of its parameters that call goes through. A reader asking what calls `build_index` finds `register`, and what `register` reaches includes `build_index`, even though the join crosses two separate calls. Only a bare name counts, so a lambda written inline and a variable bound to a function are both out of scope, the same as a callee written that way.

Where it stops, and what the gap says:

| Written as | Reason |
| --- | --- |
| a call on a parameter, `callback()`, that some caller in the run passes a function by name into | followed through the join above (no gap) |
| a call on a parameter, `callback()`, that no caller in the run passes a function by name into | the caller supplies it, and nothing named what it passed |
| a name a `for`, `with`, `except ... as`, walrus, or lambda parameter rebinds | the value could not be settled |
| a name assigned inside an `if`, `try`, or `with` block, or by unpacking | the value could not be settled |
| `from a import *` and `from b import *` when both define the name | more than one possible source |
| an import that resolves under two roots | more than one possible source |
| a call into a package whose source is not in the run | outside the run (no gap) |
| a value's attribute, `order.save()`, or a call on a call's result | no declaration to follow (no gap) |

One callee spelling that lands on two definitions in one body, `load()` under a class body that imports its own `load` say, is placed on neither.

Not followed yet: a method inherited from a base class, a callable stored in a dict or a list, a decorator's own body, a call written in a parameter default such as `Depends(get_db)`, and an attribute set on `self` in `__init__` and called elsewhere.

A summary's `identity.id` is the file relative to the project root plus the export path (`app/store.py::read_orders`, `app/models.py::Orders.total`), and `summary` on an effect is that id. Two summaries that would share an id are told apart by their boundary, then by their line.

## What a file imports from the project

Every summary has `metadata.moduleImports`, the project files its own file's imports resolved to, relative to the workspace root and sorted. A file whose imports all resolve outside the project gets an empty list rather than no field, so a Lambda handler that imports only the standard library still tells the checker that its closure is the handler module alone. A checker rebuilds the import graph from that field to work out which modules a template's handler entry loads; the entry `app.handler` under `CodeUri: src/` matches `src/app.py`, and a dotted module such as `shop.app.handler` matches `src/shop/app.py`.

## Grammar asset

`grammar/tree-sitter-python.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-python.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
