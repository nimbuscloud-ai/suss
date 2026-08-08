# @suss/adapter-python

The Python language adapter for suss. It parses source with tree-sitter (WASM), resolves names with its own lexical binder, and emits behavioral structure through the same shared assembly layer the TypeScript adapter uses.

## What this package is

`@suss/adapter-python` is the Python language adapter. It meets the Layer 1 contract in [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md): discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Python grammar (`grammar/tree-sitter-python.wasm`, so there is no native build step), builds module, class and function scopes over the tree (imports, assignments, `global`/`nonlocal`), works out which file in the repo an import points at, and finds routes on decorated functions and class methods whose decorator resolves to a module the pack was configured with. When a pack says the library mounts routers (FastAPI's `APIRouter` plus `include_router`), the adapter builds a route's path out of the two literal prefixes, one mount hop deep. When it cannot build the path, the route keeps its name, gets no path, and gets a gap explaining why. Each unit it finds becomes a `RawCodeStructure` object, which it hands to `assembleSummary` in `@suss/extractor`, the same assembly code the TypeScript adapter uses.

v0 (this slice) does nothing with the path engine. A route either has no transitions at all, or one transition that describes the response the code declares (a FastAPI `response_model` / `status_code`, or a return annotation). It never breaks a route into branches. See [`docs/internal/proposals/language-adapters.md`](../../../docs/internal/proposals/language-adapters.md) for what a later slice adds.

## Where it fits in suss

This package depends on `@suss/extractor` (for `RawCodeStructure` and `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (`@suss/framework-flask-restx`, `@suss/framework-fastapi`) use its `PythonPack` contract. Nothing in this package knows what any particular library calls its decorators.

## How a prefix is read

A mounted route's path comes from prefixes written at up to four places: the object the mount is called on, whatever that object was built from, the router's constructor, and the call that mounts it. All four go through one reader, and a given spelling means the same thing at every one of them. We got this wrong three times by fixing one place or one spelling at a time, so the whole grid is written out here.

Every cell is what the library itself does, read off its source and confirmed against a running app (`url_map` for flask-restx, the route table for FastAPI).

**At the constructor** (`Namespace(path=...)`, `APIRouter(prefix=...)`):

| Written | flask-restx serves | FastAPI serves | The reader says |
| --- | --- | --- | --- |
| nothing | `/` + the namespace's name | the route path, no prefix | unstated |
| `"/orders"` | `/orders` + the route path | `/orders` + the route path | stated |
| `"/orders/"` | `/orders` + the route path | the app does not start | stated, trailing slashes trimmed where the pack says so |
| `"/"` | the route path, no prefix | the app does not start | stated, and trimming leaves nothing |
| `""` | `/` + the namespace's name | the route path, no prefix | unstated where the pack says a no-value prefix is unstated, otherwise stated |
| `None`, `False`, `0` | `/` + the namespace's name | the app does not start | unstated where the pack says so, otherwise unreadable |
| a name or a call | whatever it evaluates to | whatever it evaluates to | unreadable |

**At the mount** (`add_namespace(ns, path=...)`, `include_router(router, prefix=...)`):

| Written | flask-restx serves | FastAPI serves | The reader says |
| --- | --- | --- | --- |
| nothing | where the constructor put it | the constructor's prefix + the route path | unstated |
| `"/api"` | `/api` + the route path, replacing the constructor's | `/api` + the constructor's prefix + the route path | stated |
| `"/api/"` | `/api/` + the route path, kept as written | the app does not start | stated |
| `""` | where the constructor put it | the constructor's prefix + the route path | unstated where the pack says so, otherwise stated |
| `None`, `False`, `0` | where the constructor put it | the app does not start | unstated where the pack says so, otherwise unreadable |
| a name or a call | whatever it evaluates to | whatever it evaluates to | unreadable |

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

## Grammar asset

`grammar/tree-sitter-python.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-python.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
