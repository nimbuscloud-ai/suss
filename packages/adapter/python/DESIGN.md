# How the Python adapter reads a project

`@suss/adapter-python` reads a Python project's routes, outgoing calls, database work and environment reads into summaries. The sections below describe how it decides each of those and where it stops. For what the package is for, see the [README](./README.md).

## Path templates

A pack declares which syntax its library uses for path parameters, under `pathParamSyntax`. The adapter reads two. `"braces"` covers `{name}` and `{name:converter}`, the syntax FastAPI gets from Starlette. `"flaskConverters"` covers `<name>`, `<converter:name>`, and `<converter(arguments):name>`, the syntax flask-restx gets from Werkzeug. With either one, the adapter rewrites the path into the IR's plain-brace form and treats the parameters in the template as path parameters.

When a pack declares nothing, the adapter keeps its paths exactly as written and does not treat any parameter as a path parameter. When a pack declares a syntax the adapter has no reader for, the adapter still discovers its routes, but gives them no path and records a gap. Packs written against 0.3 relied on brace parsing applying to every path, so those packs now have to declare `"braces"` explicitly.

## Which expression is the app

A route is a decorator, and whether it counts depends on the object the decorator is called on. `@app.get("/x")` is a route when `app` was built by calling what FastAPI exports. When `app` is some other object with a `get` method, the decorator is nothing. So for every decorator, discovery has to find out what built the object it is called on.

The rules in `@suss/resolution` work this out for every decorator. They follow the value through a binding, a property read, an import or an argument, and return the one call that built it. `originOf` then reads which module that call's callee was imported from. The TypeScript adapter asks the same rules the same question, so when the rules gain a way to follow a value, both languages get it.

The lexical binder on its own would find the app at module level and nothing else. It records only a name written directly in a body's own statement list, and it does not resolve attributes, so it finds neither app here:

```python
class Holder:
    def __init__(self):
        self.app = FastAPI()

    def wire(self):
        @self.app.get("/health")     # no scope has a binding for self.app
        def health(): ...

try:
    app = FastAPI()

    @app.get("/health")              # a name written inside a try is not bound
    def health(): ...
except RuntimeError:
    pass
```

When a name is assigned two constructions, the rules return both. Keying a route on the wrong app is worse than keying it on none, so nothing picks one of the two. If both constructions come from the same module, that is enough to tell which pack the route belongs to: the route is discovered, and the router index reports the name the two share. If they come from different modules, the decorator stays unclassified and the route is not discovered.

The adapter adds three Python facts for this. A method's receiver binds to the class the method is declared in, so `self.app` is the value the class assigns to `app`. An assignment written inside a method body binds its name; the class walk used to skip these. And an import of a package the repo cannot read still records which module the name came from. Without that, the adapter could not tell `FastAPI()` apart from a constructor of the same name that the project wrote itself.

## How a prefix is read

A mounted route's path comes from prefixes written in up to four places: the object the mount is called on, whatever that object was built from, the router's constructor, and the call that mounts it. All four go through one reader, and a given spelling means the same thing in each place. Fixing one place or one spelling at a time got this wrong three times, so the tables below cover every combination.

Every cell describes what the library itself does. We read that off the library's source and then confirmed it against a running app, using `url_map` for flask-restx and the route table for FastAPI.

**At the constructor** (`Namespace(path=...)`, `APIRouter(prefix=...)`):

| Written              | flask-restx serves         | FastAPI serves             | What suss records                                                            |
| -------------------- | -------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| nothing              | `/` + the namespace's name | the route path, no prefix  | unstated                                                                     |
| `"/orders"`          | `/orders` + the route path | `/orders` + the route path | stated                                                                       |
| `"/orders/"`         | `/orders` + the route path | the app does not start     | stated, trailing slashes trimmed where the pack declares it                  |
| `"/"`                | the route path, no prefix  | the app does not start     | stated, and trimming leaves nothing                                          |
| `""`                 | `/` + the namespace's name | the route path, no prefix  | unstated where the pack declares a no-value prefix unstated, otherwise stated |
| `None`, `False`, `0` | `/` + the namespace's name | the app does not start     | unstated where the pack declares it, otherwise unreadable                    |
| a name, a call, or an f-string the evaluator settles | whatever it evaluates to | whatever it evaluates to | stated, with the string it settles on                     |
| anything the evaluator cannot settle | whatever it evaluates to | whatever it evaluates to | unreadable                                                   |

**At the mount** (`add_namespace(ns, path=...)`, `include_router(router, prefix=...)`):

| Written              | flask-restx serves                                   | FastAPI serves                                     | What suss records                                     |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| nothing              | where the constructor put it                         | the constructor's prefix + the route path          | unstated                                              |
| `"/api"`             | `/api` + the route path, replacing the constructor's | `/api` + the constructor's prefix + the route path | stated                                                |
| `"/api/"`            | `/api/` + the route path, kept as written            | the app does not start                             | stated                                                |
| `""`                 | where the constructor put it                         | the constructor's prefix + the route path          | unstated where the pack declares it, otherwise stated |
| `None`, `False`, `0` | where the constructor put it                         | the app does not start                             | unstated where the pack declares it, otherwise unreadable |
| a name, a call, or an f-string the evaluator settles | whatever it evaluates to              | whatever it evaluates to                           | stated, with the string it settles on                 |
| anything the evaluator cannot settle | whatever it evaluates to             | whatever it evaluates to                           | unreadable                                            |

The two libraries differ on one point, and each library's pack declares which way it goes. flask-restx checks whether the path is truthy, so in both places all four no-value spellings mean the same as writing nothing. FastAPI requires a string, so an empty string is an ordinary prefix that adds nothing, and the other three stop the app from starting.

The reader then uses the result like this. A stated prefix goes into the path. An unstated one adds nothing, unless the pack declares that the library makes up a path of its own when the prefix is unstated. In that case the route abstains, because the path it is served at is somewhere suss never looked. An unreadable prefix makes the route abstain too. A route that abstains keeps its name and has no path, and the summary records why.

The trailing-slash rows differ between the two places. flask-restx trims at the constructor and not at the mount, because only the constructor's path goes through the property that strips the slash. The pack declares trimming per library. The mount side does not need it, because on that library a mount that states a prefix abstains anyway.

### The object the mount is called on

flask-restx serves a route under the prefix of the object `add_namespace` was called on, ahead of the namespace's path and the route's. That object has two prefixes of its own: one written on it, `Api(prefix=...)`, and one written on the Flask blueprint it was built from, `Blueprint(name, __name__, url_prefix=...)`. The library joins the blueprint's prefix, the `Api`'s prefix, the namespace's path and the route's path by concatenating them and dropping the falsy ones, so nothing is stripped at either of these two places.

The tables below have no FastAPI column. A FastAPI app has no prefix of its own and the pack declares none, so the object adds nothing.

**At the blueprint** (`Blueprint("api", __name__, url_prefix=...)`):

| Written | flask-restx serves | What the reader records |
| --- | --- | --- |
| nothing | the rest of the path, no prefix | unstated |
| `"/api/v1"` | `/api/v1` + the rest | stated |
| `"/api/v1/"` | `/api/v1/` + the rest, and Werkzeug serves it at the merged `/api/v1/...` | stated, and the composed path is merged |
| `"/"` | the rest of the path, once the merge collapses the doubled slash | stated, and merging leaves nothing |
| `""`, `None` | the rest of the path, no prefix | unstated |
| `False`, `0` | the app does not start: Flask hands the value straight to `rstrip` | unstated |
| a name, a call, or an f-string the evaluator settles | whatever it evaluates to | stated, with the string it settles on |
| anything the evaluator cannot settle | whatever it evaluates to | unreadable |

**At the `Api`** (`Api(bp, prefix=...)`):

| Written | flask-restx serves | What the reader records |
| --- | --- | --- |
| nothing | the blueprint's prefix + the rest | unstated |
| `"/extra"` | the blueprint's prefix + `/extra` + the rest | stated |
| `"/extra/"` | the same, concatenated as written, and Werkzeug serves it at the merged path | stated, and the composed path is merged |
| `""`, `None`, `False`, `0` | the blueprint's prefix + the rest | unstated |
| a name, a call, or an f-string the evaluator settles | whatever it evaluates to | stated, with the string it settles on |
| anything the evaluator cannot settle | whatever it evaluates to | unreadable |

**At the registration** (`app.register_blueprint(bp, ...)`), which the reader looks at only to decide whether to abstain:

| Written | flask-restx serves | What the reader records |
| --- | --- | --- |
| nothing | where the blueprint's own `url_prefix` put it | the blueprint's prefix |
| `url_prefix="/over"` | `/over` + the rest, replacing the blueprint's | abstain |
| `url_prefix=""` | the rest, replacing the blueprint's with nothing | abstain |
| `url_prefix=None` | where the blueprint's own `url_prefix` put it | abstain |
| registered on another blueprint | the outer blueprint's prefix in front of everything | abstain |
| registered twice | flask-restx refuses to start | abstain |
| never registered | nothing at all | the blueprint's prefix |

Any `url_prefix` written at the registration makes the route abstain, `None` included. The three spellings do different things: `"/over"` replaces the blueprint's prefix, `""` replaces it with nothing, and `None` falls back to the blueprint's own. So the keyword alone does not tell the reader where the routes land.

When the run finds no registration, the route keeps the blueprint's own prefix instead of abstaining. The registration may be in a file outside the run, and using the prefix the blueprint was built with makes the same claim the constructor already makes.

### A call that spreads a dictionary

`Api(**build_authorizations())` and `include_router(router, **options)` spread a value the call does not write out. The reader skips the spread and reads the keywords that are written, so the routes underneath keep their paths.

That leaves one case the reader cannot see. If the dictionary sets the prefix keyword itself, the composed path is wrong, and nothing in the output says so. Reading the prefix as unknown would be correct, but it would cost every route under every call that spreads a config dictionary, and that is most of them. The fix is to carry the uncertainty through to the summary instead of picking one of the two readings.

### Repeated slashes

A prefix written with a trailing slash leaves the composed path with two slashes. Werkzeug serves such a rule at the merged path and redirects the written one, so `/api/v1//orders` is reached at `/api/v1/orders`. The pack declares this, and the reader then merges repeated slashes in every path it composes. Starlette does not merge them, so FastAPI's pack declares nothing and its paths stay as composed.

## What a body lowers to

A route produces a transition for each place it returns or raises. To find those places, the adapter lowers a function body into the statement form that the shared path engine in `@suss/extractor` walks. The engine is generic over the language's own condition handle and never looks inside one. So Python shares the path enumeration, the negation of earlier arms, and the budget with TypeScript.

| Python | Lowers to |
| --- | --- |
| `if` / `elif` / `else` | one `if` per test, with the elif chain nested into the else arm the way Python reads it |
| `while`, `for` | `loop` |
| `try` / `except` / `finally` | `try`, with every except arm as the catch body |
| `match` / `case` | `switch`, one group per case, `case _` as the default group |
| `return`, `raise` | `exit`, so each of them gets its own transition |
| `break`, `continue` | `exit`, which the engine uses for reachability and does not report as an outcome |
| anything else | `opaque` |

A statement's exit kind comes from scanning its own subtree for a return or a raise. The scan stops at a nested `def` or `lambda`, because those belong to the function they declare. When the subtree has both, the raise wins, wherever each of them is.

So a handler written this way:

```python
def get(self, order_id) -> dict:
    if not found:
        return {"error": "nope"}, 404
    return {"a": 1}, 200
```

comes out as two transitions: the 404 gated on the opaque condition `not found`, and the 200 gated on its negation.

### A branch that ends by raising

Most frameworks let a route end a request by raising, and the client then receives whatever status the raised call was given. A pack lists the library's callables that do this under `responseStatusCalls`, along with where each one takes its status from:

```ts
responseStatusCalls: [
  {
    callee: "fastapi.HTTPException",
    statusKeyword: "status_code",
    statusArgument: 0,
  },
],
```

`callee` is the module and name as the file imports them. Matching on both keeps a project class that is also called `HTTPException` from counting as FastAPI's. A `raise` of one of these becomes a transition that responds with that status. So does a bare call to one written as a statement on its own, which is how Flask's `abort(404)` ends a request. So this handler:

```python
@app.get("/items/{item_id}")
def show(item_id: int):
    if item_id > 10:
        raise HTTPException(status_code=404, detail="missing")
    return {"id": item_id}
```

comes out as a 404 under `item_id > 10` and a 200 under its negation.

When the adapter cannot resolve a status to a number, it reports the status as the text it was written as. The transition then records that a status was set without claiming which one. A `raise` of anything the pack does not list still becomes a transition, with the exception type on it and no status, because only the framework decides what response that exception turns into.

### Keying anything on a node

tree-sitter hands back a fresh wrapper object every time a child is read, so two reads of one node are never `===` and a plain `Set` or `Map` keyed on a node matches nothing. Use `NodeSet` and `NodeMap`, which key on the node id. `npm run check:style` fails a build that keys either one on a node.

## What a body calls out to

A pack lists the callables its library provides for making a request, under `clients`. Each entry declares the module they come from, the attribute names that state the HTTP method themselves, where the URL is written as a positional and as a keyword argument, the call that takes the method as an argument instead, and the constructors whose instances accept the same calls.

The adapter looks for those calls in every function in a file. The callee resolves the same way any other callee does, so `requests.get`, a bare `get` imported from the package, and `session.get` on a value built by one of the library's constructors all match the same entry. The URL argument goes through the value evaluator and `pathOf` from `@suss/values`, the same reading a route's path gets, so an f-string and a name defined elsewhere in the project both resolve to the path they spell out.

The enclosing function becomes a `client` unit bound to that method and path. A function that makes two calls is a client of both. A call at module level has no function to belong to, and a call whose URL does not settle on a string does not claim a path. Both stay as invocation effects on whatever unit contains them.

A pack also declares which members of the response object contain the status, the success flag and the body. Those member names go on the summary. The adapter walks the caller's body the same way it walks a route's, so when the caller tests one of those members, the test becomes a path whose condition refers to that member. `suss check` reads the status in that condition and reports a caller that handles a status the other side never sends. For that to work, a condition records a member as the name it starts from plus the members read off it. Without that, nothing could find the status in the condition.

## What a body does with the database

A pack lists the query types its library defines. A call chain matches when the method behind it declares that it returns one of them:

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

Matching on the return type is how the adapter reads a project's own wrapper. A measured Flask service imports `sqlalchemy` in 50 files, and every one of its 157 queries still goes through a base class the call sites never import:

```python
# in the project, not in the library
class Base:
    @classmethod
    def query(cls) -> Query: ...

class Orders(Base): ...

# in a handler, importing neither the base nor SQLAlchemy
found = Orders.query().filter_by(id=1).first()
```

A recognizer keyed on the import does not find any of those queries. Following the call to `Base.query` and reading its declared return type finds all of them. The hop from the subclass to the base comes from `contains`, which reads `holdsProperty` and adds what a base class declares.

The adapter treats a chain as one operation, so the three calls above are one read. It resolves the call that starts the chain, and the method the chain ends with decides whether it is a read or a write. When a base and a subclass both declare that method, it resolves to two definitions and the adapter claims nothing.

A chain also matches when the name it starts on is declared as one of the query types where the chain is written. That covers a parameter annotated `db: Session`, a local bound by `session = Session()` or `with Session() as session:`, and a project function whose return annotation says `Session`. Where the source annotates nothing, the resolution rules follow the name to what built it. So `db = open_session()` matches on the `Session()` inside `open_session`, even though that function annotates no return. The type has to come from the pattern's module, through however many aliases and re-exports the project put in between, so a project class that happens to share the name does not match. `recordsNothing` lists the methods on such a type that touch no rows of their own: `execute` runs a statement whose own chain is the read or write, and `close` manages the session.

A query built from a function the library exports has no project method in between whose return type the adapter could read. So a pack lists those functions by name, and a call site that reaches one of them matches. The rules find where the name came from, so the adapter follows a project module that re-exports `select`:

```ts
queryFunctions: ["select", "insert", "update", "delete"]
```

For one of these the function itself is the operation, so `update(User).where(...).values(...)` is an update however the chain ends.

`fields` comes from the columns a query spells out, `User.id` in `select(User.id, User.email)`, and from the keywords of a call the pack lists under `valueMethods`, `name` in `.values(name="x")`. `selector` comes from the keywords that every other call in the chain selects rows by, `id` in `filter_by(id=user_id)`. Raw SQL passed to `text` is read as its own effect, with the kind and table taken from the statement.

## A statement the project wrote as SQL

Some libraries run a statement the project wrote as SQL instead of building one. SQLAlchemy exports a function for this, and a pack lists the function and the module it comes from:

```ts
rawSql: [{ module: "sqlalchemy", functions: ["text"], storageSystem: "postgresql" }]
```

A cloud warehouse gives the project a client object instead, and the statement goes to a method on it. `sqlClients` declares the class, the module it comes from, and where each method takes its input:

```ts
sqlClients: [
  {
    module: "google.cloud.bigquery",
    clientTypes: ["Client"],
    statements: [{ method: "query", argument: 0, keyword: "query" }],
    tables: [{ method: "get_table", argument: 0, keyword: "table", kind: "read" }],
    handsBack: [{ method: "get_client", module: "...", name: "Client" }],
    storageSystem: "gcp.bigquery",
    dialect: "bigquery",
  },
]
```

`receiverTypes.ts` works out the class of the value a method is called on, and the ORM chains use the same code. It takes the annotation written beside the name. Where there is none, it asks the rules which call assigned the name. So a client built in one module and called in another still matches, and so does one that a project factory returns. The class may be written as a plain name the file imported, `Client`, or as an attribute on an imported module, `bigquery.Client`, and both resolve to the same module and name.

A class-body assignment is recorded one of two ways. `TABLE = "orders"` is a plain attribute that every instance shares, so it is `holdsProperty` and a read through `self` or through any instance finds it. `is_admin: bool = False` is a field default in a dataclass, a pydantic model or an attrs class, whose generated constructor lets each construction give its own value, so it is `holdsDefault`. A field default is read only off a construction written with no arguments, which is what `callArgCount` records for every call. `settings = Settings()` reads its defaults, and a handler taking `account: Account` reads none. An annotated attribute on a class that is none of those is recorded as a field default too, since the adapter cannot see whether a library generates the constructor.

Reading a property runs its getter, so the adapter records what the getter returns under the property's name, one `holdsProperty` row per `return`, and a read finds that value rather than the getter function. The setter and the deleter are not recorded under the name at all. A def is a getter when it is written under `@property` or `@functools.cached_property`, or when the class body writes a `@name.setter` or `@name.deleter` for its name, which covers a library's own kind of property without the adapter knowing the library.

The adapter reads a `statements` argument through the value evaluator, so an f-string, a `+`, and a constant another module defines all read the same as a statement written out at the call. A piece the evaluator cannot settle becomes a parameter, which the statement would have had in that place anyway. `path` lists the keys to follow when the statement is inside a dictionary: `["query", "query"]` for a method taking `configuration={"query": {"query": sql}}`. `tables` covers a method that takes a table name instead of SQL, and the adapter reads that argument as a string and nothing more.

`handsBack` is the one hop a pack can declare between two of its library's classes. Nothing in the project states what one of the library's methods returns, so the adapter does not infer it. A chain like `hook.get_client().query(sql)` matches because the hook's pattern declares that `get_client` returns the warehouse client.

For a table written as `project.dataset.table` or `dataset.table`, the adapter puts the last part in `container` and the part before it in `scope`. A part the statement left as a parameter contributes nothing. So a name whose group part is unsettled keeps `scope` at `default`, and a statement whose table is unsettled does not produce an effect. Neither do `BEGIN`, `COMMIT`, and the other statements that do not touch a table.

## What a model query gives back

A handler also uses a query to get an instance of one of the project's own model classes, and the methods it then calls on that instance are project code:

```python
item = session.get(Item, item_id)
item.deactivate()
```

Nothing in the run declares `get`. SQLAlchemy declares it, and the adapter does not read SQLAlchemy. So a pack declares what its library's calls return, under `models` next to `storage`:

```ts
models: [
  {
    baseNames: ["DeclarativeBase", "declarative_base", "SQLModel"],
    givesBack: ["filter", "where", "first", "all"],
    entryMethods: [{ method: "get", argument: 0 }],
    entryFunctions: [{ module: "sqlmodel", name: "select", argument: 0 }],
    relationships: [{ module: "sqlmodel", name: "Relationship" }],
  },
]
```

While it reads the run, the adapter adds each of these to the facts, paired with every base name the declaration lists:

```
givesBackOneOfArgument  SQLModel  get     0
givesBackOne            SQLModel  first
givesBackOneOfImport    sqlmodel  select  0
```

The shared rules read those facts. In Python the class is passed as an argument, where a Rails finder is called on the class itself. So `entryMethods` and `entryFunctions` declare which argument has the class. That argument has to reach one of the base names, and this keeps `config.get("timeout")` from matching. A function called on its own is also keyed on the module it was imported from, because a project can define a `select` of its own.

Once the class is settled, the rest of the chain is method calls on that receiver, and `givesBack` covers it one method at a time. `session.query(Item)` is one `Item`, `.filter(...)` off that is one again, and `.first()` after that is one more.

`baseNames` covers the three ways SQLAlchemy and SQLModel let a project declare a base. `class Base(DeclarativeBase)` and `class Item(SQLModel, table=True)` give the name written in the class list, which the adapter records as `extendsNamed`. `Base = declarative_base()` gives the name of the function that built it. The shared rules reach that name through the call that assigned `Base`.

## What a relationship reaches

`relationships` lists the callables a library provides for a field that points at another model: SQLModel's `Relationship` and SQLAlchemy's `relationship`. Each becomes an `associationConstructor(module, name)` fact. Separately, the adapter records a fact for every class-body field assigned from a call, whichever call it is:

```
fieldCall  app/models.py:40-260  items  app/models.py#Relationship  app/models.py#Item
```

The third column is the callable and the fourth is the class the field refers to. Neither fact is specific to Python, and neither decides which fields are associations. A shared rule in `@suss/resolution` joins the callable through `comesFrom` and keeps the ones a pack declared, so a project function that happens to be named `Relationship` matches nothing. Because the adapter does not decide, it records a fact for nearly every field: 1046 of them on a measured SQLAlchemy service, of which 191 are `relationship` and the rest are `Column` and pydantic's `Field`. Deciding in the adapter would put the pack's vocabulary there.

The class comes from the annotation when there is one, with the wrappers removed: `list[Item]`, `List[Item]`, `Optional[Item]`, `Item | None`, `Mapped[Item]` and `Mapped[list["Item"]]` all refer to `Item`. A forward reference in quotes gets the same key as the bare name, so the module's imports resolve it either way. With no annotation, the call's first argument gives the class, as in `participants = relationship("Participant")`.

The shared rules take it from there. `user.items` resolves to one `Item`, and a `select` over it or a call on one of its elements composes the same way as for any settled class.

## Where a mount is written

Almost no service mounts anything at the top level of a module. It builds its routers or namespaces there, each with a literal prefix, and registers them inside the function that builds the app, often by looping over a list that another function built:

```python
def create_app():
    app = Flask(__name__)
    api = Api(app)
    for namespace in loader.load_namespaces():
        api.add_namespace(namespace)
    return app
```

So suss looks for mounts inside function bodies as well as at the top level. It still reads constructor calls only at the top level, which is where people write them. It misses a mount inside an `if`, a `try`, a `with`, a `while`, or a class method, because the binder records no name written inside one of those, and a mount there would resolve to nothing anyway.

A mount inside a `for` goes one of two ways, depending on whether the source lists the routers the loop covers.

| The loop reads | What suss does | Why |
| --- | --- | --- |
| a list or tuple of bare names, `for ns in [orders, users]` | mounts each of those names, exactly as a mount call that named it would | every element is a name the existing one-hop rule already follows |
| anything else, `for ns in loader.load_namespaces()` | mounts nothing, and every router it never saw mounted by name records the loop as the reason | no file shows which routers the call returns |

Claiming a path for the second row would mean two guesses at once: that this router is in the collection at all, and that the mount states no prefix that would replace or extend the router's own. A wrong path is worse than no path here. A claimed path pairs the route with a contract on the other side, and every check after that treats the path as fact, with no way to tell it apart from a path suss followed all the way.

The second row does improve the explanation. A router nobody mounts by name used to report "is never mounted through a single variable binding in the files read", which sent a reader looking for a registration that was sitting in the app factory all along. When suss saw a loop it could not enumerate, the reason now says so instead. It points at the fix that works: list the routers out in the source, or give suss the list.

Both rows were checked against a running app. A loop over a literal list serves each namespace under its constructor path, the same paths the direct mounts serve. A `path=` written on the mount inside the loop replaces every namespace's own path, which is one more reason not to treat a loop's mount as an ordinary registration.

### A mount inside a function runs only if the app calls that function

A mount at a module's top level runs on import, so it applies whenever the module loads. A mount inside a function is only a candidate, because suss cannot tell which functions the app calls. That goes wrong in a repo with a test factory next to the app factory:

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

Taking the only mount suss could follow would put the route at `/test`, where no request ever arrives. So suss drops a mount written inside a function when it also saw a loop it could not enumerate somewhere outside that function. The route abstains, and its reason mentions both the function and the loop.

Both conditions matter. Counting only loops keeps the ordinary case working: two factories that each register their own routers by name do not compete, because neither could have registered the other's routers. Counting only a loop in a *different* function keeps a factory working when it mixes an explicit registration with a loop, since both run whenever that function runs.

A module-level mount is never dropped this way. It runs whichever factory the app calls.

## What a file reads from the environment

`os.environ` is part of the standard library, so the adapter recognizes reads of it without a pack. Each read becomes the same `config-read` interaction that the TypeScript adapter emits for `process.env.X`, on the `runtime-config` binding, and is spelled `os.environ["X"]` whichever way the source wrote it. The runtime-config checker pairs those reads against what a template declares for the function the file runs in.

| Python | Recognized as | Defaulted |
| --- | --- | --- |
| `os.environ["X"]` | a read of `X` | no |
| `os.environ.get("X")` | a read of `X` | no |
| `os.environ.get("X", "d")`, `os.environ.get("X", default="d")` | a read of `X` | yes |
| `os.getenv("X")`, `os.getenv("X", "d")` | a read of `X` | as above |
| any of these followed by `or` (`os.environ.get("X") or "d"`) | a read of `X` | yes |
| `if os.environ.get("X"):`, `if "X" in os.environ:` then `os.environ["X"]` in the branch | a read of `X` | yes: used only where a test passed |
| `x = os.getenv("X")` in a function, then `if x is None: return ...` and `x` after it | a read of `X` | yes, when every use of `x` comes after a test passed |
| `x = os.getenv("X")`, then `x` used both inside and outside `if x:` | a read of `X` | no |
| `if os.environ["X"]:`, or `x = os.environ["X"]` then `if x:` | a read of `X` | no: the subscript raises before the test runs |
| `if not os.getenv("X"): raise ...`, or `if x: return x` then `raise ...` | a read of `X` | no: a missing value ends in a raise |
| `import os as _os`, `from os import environ, getenv` | the same reads, through the alias | |
| `os.environ[name]` where `name` is a parameter | nothing here, and a read at each call that supplies the name (below) | |
| `os.environ.get(f"{prefix}_X")`, `os.environ[opts["key"]]` | nothing: nothing in the run shows which variable that is | |
| `os.environ["X"] = "1"`, `del os.environ["X"]`, `"X" in os.environ` | nothing: a write or a membership test | |
| `os.environ.get("X") or os.environ.get("Y")` | `X` defaulted, `Y` not, since `Y` is the chain's last resort | |

A read inside a route body goes on that route's summary. A read at module level, or in a class body, runs when the module is imported, so it goes on a `module-init` summary named after the file, one per file. A read inside a function that a route reaches through its calls goes on that function's own summary (see below). A read inside a function that nothing discovered and nothing reaches is reported nowhere, because nothing in the run shows when that function runs.

A file gets that `module-init` summary when its module scope reads the environment or calls a project function, and no summary at all when it does neither.

### A read through a project helper

A service that reads its environment through a function of its own writes no variable name at the read:

```python
# settings.py
def env(key, default=None):
    return os.environ.get(key, default)

# db.py
DATABASE_URL = env("DATABASE_URL")
POOL_SIZE = env("POOL_SIZE", 5)
```

The adapter records two facts, and the rules combine them. `readsKeyed(site, o, x)` records that the read at `site` takes the entry of `o` whose key `x` works out to, for any container. `environmentObject(w)` records that `w` is written as `os.environ`. The shared rules in `@suss/resolution` derive `readsEnvNamed(site, x)` from the two, and then `paramNamesEnv(p, site)`. That relation is true when a parameter ends up as the name a read site looks up, either because the site reads the parameter directly or because the parameter is passed on to another helper's parameter that does. That one rule covers forwarding through any number of helpers, across files.

Keeping the two facts separate lets a read count when it is taken off something other than `os.environ`. `make_reader(os.environ)` returning `lambda name: env[name]` reads the environment through a parameter, and a scan of the helper's file would miss it, because that file never writes `os.environ`. `environmentValue(w, o)` starts from the object instead and follows it through the names assigned to it and the parameters callers pass it to. A keyed read off any of those is an environment read.

The query is keyed on the environment objects. A project writes `os.environ` in a handful of places and has thousands of parameters that something could be passed to. So the run seeds `wantedEnvObject` once with every environment object the adapter recorded, and keeps the result: for each parameter, the read sites whose variable name its value ends up as. `os.getenv(name)` has no container, so the adapter records the `os.getenv` reference itself as the environment object and records the read against it.

At `env("DATABASE_URL")`, the reader finds the callee and looks up each of its parameters in that one result. It reads the argument only for a parameter that appears there. The variable name is the argument's own value, either as a literal or as whatever the evaluator folds it to.

A variable has a fallback when every read the call reaches supplies one, or when the caller wrote an `or` of its own around the call. Both calls above are defaulted, since `os.environ.get(key, default)` returns `default`. So is `env("HOST") or "localhost"` against a helper that raises. When two reads inside the helper look up the same variable, the call gets one read, and it is defaulted only if both of them are.

The read is reported at the call, in the caller's unit. A call at module level lands on that file's `module-init` summary, and a helper called from two units gives each unit its own read.

The callee can also be a value instead of a name the project declares, as long as the value comes from a call the project makes. `env = make_reader()` then `env("A")` reads `A`, whether `make_reader` returns a nested `def` or a lambda. The reader asks what the callee returns as well as what it resolves to, and one rule states that calling a name a factory assigned runs the function that factory returned.

A helper that is passed the environment itself works too: `make_reader(os.environ)` returning `lambda name: env[name]`, and the same through any number of calls. The argument has to resolve to `os.environ`; a plain dict reads nothing. The reader treats a read in that helper's own body as having no fallback, because nothing scanned that body for one.

Out of scope: a name built out of a parameter (`env(f"{prefix}_URL")` reads nothing), a helper that takes the name off a dict or an options object instead of a parameter, and a helper built by `functools.partial`.

In a project where every read writes out its own variable name, no expression is treated as the environment, and the reader never asks anything at a call.

## What a route, or a module loading, reaches

A route's body calls project functions, and those call others. Each function a route reaches this way gets its own summary of kind `library`, bound as `function-call` with `transport: "in-process"` and `recognition: "reachable"`. That summary lists the calls, environment reads and database work in the function's own body. Each invocation effect on a route or a reached function records, in `summary`, which summary the call lands on. A reader answering "what does this route reach" follows `summary` from one unit to the next and never has to match a name. The TypeScript adapter runs the same walk and produces the same output.

The walk starts at every discovered route and at every file's module scope. It adds a `calls` fact for each call in a body it could follow, until the set stops growing. A function two routes both reach gets one summary, and so does one that a route and a module both reach.

A job that a scheduler runs has no route at all: its entry file opens a pool and does its work while the module loads. So the walk also starts at module scope, with the file's `module-init` summary as the caller, and the module's calls go on that summary the way a route's calls go on the route's. A call counts when it is written in the module's own statements, including one under `if __name__ == "__main__":` or inside a module-level `try` or `for`, and one written as an argument (`asyncio.run(main())`) or as a variable's initializer (`pool = make_pool(settings)`). The walk stops at a function or lambda body, which runs only when something calls it. It also stops at a class body. Python runs a class body while the module loads, so a call written directly in a class body is left off the `module-init` summary. A decorator applied to a definition does not count as a call the module makes.

The walk records a call it could not follow once per callee, on the summary of the body the call is in, as an `unfollowedCall` gap with the reason. It skips the gap when nothing could have done better with the call: a call to a parameter that some caller passes a function by name into, or a call into a package that is not in the run.

The walk follows a callee only through a binding that records where it came from. The binder's scopes settle a name written in the file, and the import resolver settles a name imported from another file in the run.

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

A function passed by name into a call is followed one hop further than the call itself. `register(build_index)` records where `build_index` is declared, keyed to its position among `register`'s arguments. `register`'s own body calling `handler()` records which of its parameters that call goes through. A reader asking what calls `build_index` finds `register`, and what `register` reaches includes `build_index`, even though the join crosses two separate calls. Only a bare name counts. A lambda written inline and a variable bound to a function are both out of scope, the same as a callee written either way.

Where the walk stops, and the reason the gap gives:

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

When one callee spelling resolves to two definitions in one body, for example `load()` under a class body that imports its own `load`, the call is placed on neither.

A bare name that nothing declares is left unplaced, and the link step then looks for a summary of that name in the caller's own file. A method call that nothing declares, `order.save()`, is placed at its own call instead, so it links to nothing. A module function called `save` in the same file is never what a method call runs.

Not followed yet: a method inherited from a base class, a callable stored in a dict or a list, a decorator's own body, and an attribute set on `self` in `__init__` and called elsewhere. A function written in a parameter default such as `Depends(get_db)` is not a call the route makes. It runs around the route, and the next section describes how the adapter reads it.

A summary's `identity.id` is the file relative to the project root plus the export path (`app/store.py::read_orders`, `app/models.py::Orders.total`), and `summary` on an effect is that id. When two summaries would share an id, their boundary tells them apart, and then their line.

## What runs around a route

Code outside a route's body can also respond for the route. A FastAPI dependency that raises 401, a middleware that returns 429, and an exception handler that turns a `ValueError` into a 500 all respond for the route without appearing in it. Each of those gets its own summary. The route lists them under `metadata.wrappers.applied` in the order they run, and the extractor composes their transitions into the route's, setting `wrappers.from` on each transition a wrapper contributed. The extractor's README describes how that composition works. The adapter's part is reading the registrations, as follows.

A pack declares each way its library attaches something around a route, in `wrappers` on a discovery pattern. There are two forms:

| Form | Reads | Example |
| --- | --- | --- |
| `dependency` | a function passed to one of `callees` inside a `keyword` list, on the app or router construction, on the route decorator, or in a parameter default | `Depends(require_caller)` |
| `decoratedWrapper` | a function decorated with `attribute` on the app or router object | `@app.middleware("http")`, `@app.exception_handler(ValueError)`, `@app.before_request` |

Each form declares which constructions register it and how far the registration reaches. A registrar with `covers: "everyRoute"` (the app) reaches every route the pack discovers. One with `covers: "ownRoutes"` (a router or namespace) reaches the routes decorated on that same object, told apart by where the object was constructed. The adapter reads a registration only where it recognizes the object the same way it recognizes a route decorator's object. So `app = FastAPI(...)` in one module and `@app.middleware` in another are joined through the import, the same way a route on an imported router is.

How the adapter reads a wrapper's body depends on the form:

- A `dependency` runs to completion before the handler. Each `raise` of a response status is a response of its own, and every `return` passes control on to the route.
- A `decoratedWrapper` with `continuationParam` (FastAPI middleware) passes control on at the statement that calls that parameter, and anything after the call is not read. A `return` that does not call it responds on its own.
- A `decoratedWrapper` with `returnedValueResponds` (Flask's `before_request`) responds with whatever it returns, and passes control on only where it returns nothing.
- A `decoratedWrapper` with `throwParam` (an exception handler) runs only for a request that raised. Its responses replace each of the route's paths that end in a `raise` the pack does not read as a response. A raised `HTTPException` or `abort` already has a status, so no handler applies to it.

Wrappers run in the order the library runs them: middleware first, then dependencies from the app, the router and the route in that order, then exception handlers over whatever raised. Two registrations of the same function are one wrapper.

Not read yet:

- `include_router(router, dependencies=[...])` and `add_middleware(SomeClass)`. A dependency at the mount and a middleware given as a class are missed.
- Which exception type a handler is for. Every handler applies to every unread raise, so a route with two handlers reports both statuses on the paths that raise.
- A dependency's own dependencies. `Depends(f)` where `f` takes `g: str = Depends(g)` reads `f` only.
- A parameter default that refers to something other than a function at module scope, such as a method or a variable bound inside a function.
- Flask's `before_request` on a blueprint. A flask-restx route is decorated on a namespace, and the blueprint is where it is mounted, so only the app's hook is read.

## What a file imports from the project

Every summary has `metadata.moduleImports`: the project files that its own file's imports resolved to, relative to the workspace root and sorted. A file whose imports all resolve outside the project gets an empty list instead of a missing field. That way a Lambda handler that imports only the standard library still shows the checker that its closure is the handler module alone. A checker rebuilds the import graph from that field to work out which modules a template's handler entry loads. The entry `app.handler` under `CodeUri: src/` matches `src/app.py`, and a dotted module such as `shop.app.handler` matches `src/shop/app.py`.

## Where an absolute import is looked for

The adapter looks for `import orders.routes` under each root: the project directory first, then the source directories the project declares. `sourceRoots.ts` reads those from `pyproject.toml` (setuptools `package-dir` and `packages.find`, hatch `packages`, poetry `packages`). Installing the project is what puts them on `sys.path`, and suss does not install anything. When nothing is declared, `src/` is a root if it contains a package and is not a package itself. `extractPythonProject` and `PythonWhySession` both work out the roots from the project directory, so a library caller gets the same roots as the CLI. `roots` overrides them, and `additionalRoots` adds roots the directory does not show, such as a checked-out submodule.

When two roots both have a file for an import, `moduleResolver.ts` abstains instead of choosing, because the order of `sys.path` is known only at run time. So adding a root never picks the wrong module. At worst it turns a resolved import into an ambiguous one.

A `pyproject.toml` that does not parse comes back in `unreadManifests` with a one-line reason, and the `src/` fallback still applies.
