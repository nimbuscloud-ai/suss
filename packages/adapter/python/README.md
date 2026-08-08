# @suss/adapter-python

Python language adapter for suss. It parses source with tree-sitter (WASM), resolves names with its own lexical binder, and emits behavioral structure through the same shared assembly layer the TypeScript adapter uses.

## What this package is

`@suss/adapter-python` is the Python language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Python grammar (`grammar/tree-sitter-python.wasm`, no native build step), builds module/class/function scopes over the tree (imports, assignments, `global`/`nonlocal`), resolves an import to the repo file it names, and discovers routes from decorated functions and class methods whose decorator resolves to a pack-configured module. When a pack declares router mounting (FastAPI's `APIRouter` plus `include_router`), the adapter composes a route's path from the two literal prefixes, one mount hop deep, and a route it cannot compose keeps its name with no path and a gap saying why. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the TypeScript adapter uses.

v0 (this slice) does no path-engine work: a route's transitions are empty, or one transition describing a declared response shape (a FastAPI `response_model` / `status_code`, or a return annotation), never a decomposed branch. See [`docs/internal/proposals/language-adapters.md`](../../../docs/internal/proposals/language-adapters.md) for what a later slice adds.

## Where it sits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (`@suss/framework-flask-restx`, `@suss/framework-fastapi`) consume its `PythonPack` contract; nothing in this package knows what any particular library's decorators are named.

## How a prefix is read

A mounted route's path is composed from prefixes written at two sites: the router's constructor and the call that mounts it. Both go through one reader, and what a spelling means at one site it means at the other. Three rounds of this went wrong by fixing one site or one spelling at a time, so the whole grid is written down here.

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

The two libraries differ on one property, and the pack states it: flask-restx asks whether the path is truthy, so all four no-value spellings mean the same thing as writing nothing, at both sites. FastAPI wants a string, so an empty one is an ordinary prefix that happens to add nothing and the other three stop the app from starting.

What the reader does with each answer: a stated prefix composes; an unstated one adds nothing, unless the pack says the library derives a path when the prefix is unstated, and then the route abstains, because the path it is served at is somewhere this reading never looked; an unreadable one abstains. An abstaining route keeps its name and names no path, with the reason on the summary.

Note the asymmetry in the trailing-slash rows: flask-restx trims at the constructor and not at the mount, because only the constructor's path goes through the property that strips it. The pack declares trimming per library, and the mount side does not need it, since a mount that states a prefix on that library abstains anyway.

## Where a mount is written

Almost no service mounts at the top level of a module. It builds its routers or namespaces there, with a literal prefix each, and registers them inside the function that builds the app, often by looping over a list that another function assembled:

```python
def create_app():
    app = Flask(__name__)
    api = Api(app)
    for namespace in loader.load_namespaces():
        api.add_namespace(namespace)
    return app
```

So the reading looks for mounts inside function bodies as well as at the top level. Constructions are still read at the top level only, which is where they are written. A mount inside an `if`, a `try`, a `with`, a `while`, or a class method stays invisible, because the binder records no name written inside one of those and a mount there would resolve nothing anyway.

A mount inside a `for` splits in two, on whether the source says which routers the loop covers.

| The loop reads | The reading | Why |
| --- | --- | --- |
| a list or tuple of bare names, `for ns in [orders, users]` | mounts each of those names, exactly as a mount call naming it would | every element is a name the existing one-hop rule already follows |
| anything else, `for ns in loader.load_namespaces()` | mounts nothing, and every router the run never saw mounted by name says the loop is why | which routers the call returns is not written in any file |

Claiming a path off the second row would take two guesses at once: that this router is in the collection at all, and that the mount states no prefix that would replace or extend its own. A wrong path is worse than no path here, because a claimed path pairs the route with a contract on the other side and every check downstream reads it as fact, with nothing to distinguish it from a path the reading followed all the way.

What the second row does buy is the sentence. A router nobody mounts by name used to read as "is never mounted through a single variable binding in the files read", which sends a reader looking for a registration that is right there in the app factory. When the run saw a loop it could not enumerate, the reason says so instead, and the repair it points at (enumerate the list in the source, or hand suss the list) is the one that works.

Both rows were checked against a running app: a loop over a literal list serves each namespace under its constructor path, the same paths the direct mounts serve, and a `path=` written on the mount inside the loop replaces every namespace's own path, one more reason not to read a loop's mount as a plain registration.

### A mount inside a function runs only if the app calls that function

A mount at a module's top level runs on import, so it is the mount. A mount inside a function is a candidate, and the reading has no idea which functions the app calls. A repo with a test factory beside the app factory is where that bites:

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

Taking the only mount it could follow would serve the route at `/test`, which no request ever reaches. So a mount written inside a function is dropped when the run also saw a loop it could not enumerate, written anywhere other than that same function. The route abstains, naming both the function and the loop.

The two qualifiers matter. Restricting it to loops keeps the ordinary shape working: two factories that each register their own routers by name are not rivals, because neither could have registered the other's. Restricting it to a *different* site keeps a factory that mixes an explicit registration with a loop working, since both of those run together whenever that function runs.

A module-level mount is never dropped this way. It runs whichever factory the app calls. flask-restx trims at the constructor and not at the mount, because only the constructor's path goes through the property that strips it. The pack declares trimming per library, and the mount side does not need it, since a mount that states a prefix on that library abstains anyway.

## Grammar asset

`grammar/tree-sitter-python.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-python.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
