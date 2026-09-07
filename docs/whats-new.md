---
title: What is new in suss
description: The latest round of changes, first what they mean if you use suss and then what they mean if you work on it.
---

# What's new

The latest round of changes, in two passes: what it means if you use suss, and what it means if you work on it.

## If you use suss

**A GitHub Action posts the behavior diff on a pull request.** Point a workflow at `nimbuscloud-ai/suss/.github/actions/inspect-diff@main` and it reads both sides of the pull request, runs `inspect --diff` over them, and posts one comment that it edits again on every push. The comment says which units changed behavior and how they changed, whether or not the pull request edited the lines they are on. It keeps both summary files as an artifact of the run. The [action README](https://github.com/nimbuscloud-ai/suss/tree/main/.github/actions/inspect-diff) has a workflow to copy. Runs share suss's per-file cache, so reading the head costs about what the pull request touched. If the workflow also runs when something lands on `main`, it reads each of those commits as it goes, and a later pull request compares against what it already read.

**`inspect --diff` reports what changed at each boundary.** The diff used to list the units that moved, a block each. A reviewer reading that learned a file gained a function, which the pull request's own diff shows better. The report now opens with the boundaries: what each route, consumer or Lambda responds with, and what a request reaches or stopped reaching through the calls it makes.

```
1 boundary changed: 1 outcome, 1 effect. 2 units inside the project also changed.

~ serves GET /orders/{id}  src/app.ts::show  (1 outcome, 1 effect)
  outcomes
    + 404 { error }  when  order == null
  effects
    + reads mongodb:orders  through loadOrder -> readOrder
```

An outcome that reached several routes from one filter, middleware or error handler is said once, above the blocks, with how far it reaches and which routes it missed:

```
From require_login  app/controllers/application_controller.rb
  + 401  when  session[:user_id].nil?
    at 14 of the 15 boundaries it runs on
    not at GET /health, which it also runs on
```

A unit further down the call chain gets no block of its own, since the boundaries that reach it already show what its change did. Under the boundaries, the files with units that moved. A unit with a couple of lines to its name has them written out, one with more gets a count of the outcomes and the effects that moved, and one with a block of its own above is only named. A chain longer than three calls prints its first and last with `(2 intermediate units collapsed)` between them; `--chain full` prints every call and `--chain 0` prints none. Two more flags cap what the report costs: `--changed-files` takes the paths a change touched, one per line, so those files come last, and `--budget` stops the report at a number of characters and counts what it left out. The action passes both.

**`inspect --diff` reports every caller of a route, and a narrowed branch as one line.** Several clients of one route used to collapse to one entry, so a change to any of the others printed as no change; each client now pairs by its own name under the route, as `client:GET /pet/{petId}::getPetById`. A transition that kept its output and changed its guard used to print as a removed line and an added one, and now prints as one `~` line with the guard before and the guard after.

**A handler is compared against the OpenAPI document for its route.** A service with its own OpenAPI file and no client in the run used to come back from `suss check` as `Nothing was compared.`, with a note that the route was claimed by two files. The handler and the document are now paired on the route, so a status the code produces and the document does not declare is an error, and a response the document declares that no path produces is a warning.

**Middleware and hooks the project builds itself reach the routes they wrap.** A Hono middleware returned by a project factory such as `requireCaller({ header: "x-caller" })` used to be skipped, and a zod-openapi `defaultHook` given to the app constructor was never read, so every route's 401 or 400 was missing. Both now reach the routes on the app. A route's declared contract is compared against what the handler and its wrappers produce together, so a status a shared error handler produces no longer prints as declared but never produced on every route it covers, and a status spread into a route object's `responses` from a shared object is read as declared.

**A Ruby condition says what it tests, and a Ruby caller says which statuses it handles.** Every condition on a Ruby summary used to be the text it was written as, so nothing could read the status a guard names. A comparison, `nil?`, a member read and a negation each come out as themselves now, and a member read says the name it starts from and the members read off it. That is what the Faraday and Net::HTTP packs needed:

```ruby
response = conn.get("/orders/#{id}")
return nil if response.status == 404
```

Against a Rails action that never sends a 404, `suss check` now says `Consumer expects status 404 but provider never produces it`. Net::HTTP hands the status back as a string, and `response.code.to_i == 404` is read as a test on `code`.

**A Python caller says which statuses it handles, and `check` compares them.** A function that calls another service and tests the response used to come back with one path and no conditions, so nothing could be compared against what the other side sends:

```python
def fetch_order(order_id: str):
    response = requests.get(f"{ORDERS_BASE}/orders/{order_id}")
    if response.status_code == 404:
        return None
    return response.json()
```

`suss check` now reports `Consumer expects status 404 but provider never produces it` when the route on the other side does not send one. The requests and httpx packs say which members of the response mean the status, the success flag and the body, and the caller's own body is walked the way a route's is. To pair the two sides, the checker has to know which member a condition read and what it compared against. Python conditions now record both, in a route as much as in a client.

**Ruby's own HTTP client is read too.** `-f net-http` covers the standard library, in both the ways it is written: a module call such as `Net::HTTP.get(URI(...))`, and the longer form where a project builds a request object and sends it.

```ruby
uri = URI("https://api.example.com/orders")
http = Net::HTTP.new(uri.host, uri.port)
http.request(Net::HTTP::Post.new(uri))
```

That comes back as a client of `POST /orders`. `URI(...)` and `URI.parse(...)` belong to Ruby, so they sit in the value tables next to `File.join`. Anything in a Ruby run that reads a path reads through them now.

**httpx and aiohttp read the same way requests does.** `-f httpx` and `-f aiohttp` cover the other two libraries a Python service calls out with, including a client or a session opened as a context manager:

```python
async with aiohttp.ClientSession() as session:
    async with session.get(f"/orders/{order_id}") as response:
```

For that, the Python binder had to bind what `with X() as name` opens, and every name the adapter resolves goes through that binder.

**A Ruby method that calls out through Faraday is a client of the route it calls.** `@suss/client-faraday` reads a request method on the module itself and on a connection `Faraday.new` built, so a service object comes back bound to the route it reaches. A connection built with `url: "https://api.example.com/v1"` serves its calls under `/v1`, and an interpolated path reads as the path parameter it states. Run it as `-f faraday` beside the rails pack.

**A Python function that calls out over HTTP is a client of the route it calls.** A FastAPI or Flask project used to report its own routes and its database calls, and nothing it reached, so `suss check` had no consumer side in Python at all. `@suss/client-requests` reads the calls requests gives a project, and a function that makes one comes back bound to the method and path it states:

```
GET /orders/{order_id}  (requests client | line 8)
```

That pairs with whatever serves the route in the same run: a route in the same project, a handler from another repository read into the same folder, or an OpenAPI document read with `suss contract`. The seven verb functions, `requests.request("PATCH", url)` and a `Session` all read the same way, and the URL goes through the same value evaluator a route's path does, so an f-string and a name defined elsewhere both resolve to the path they build.

**A Rails action reports what its before_action filters respond with.** A controller that writes `before_action :require_login` used to report only what the action's own body does, so a route behind a login check looked like it always returned 200. Each filter method now gets a summary of its own, saying what it responds with and where it hands the request on, and every action it covers reports the two together: 401 under the filter's own test, and the action's outcomes under the negation of it. `only:`, `except:` and `skip_before_action` decide which actions a filter reaches, a filter written on `ApplicationController` reaches every controller that inherits it, and a `rescue_from ... with:` handler is reported on the paths that raise. Looking up a superclass by name follows Rails' autoloading now, so a base class in `app/controllers` is found. Before this, only a file sitting directly under `app` was.

**A Python route reports what its dependencies, middleware and error handlers respond with.** A FastAPI dependency that raises 401, an `@app.middleware("http")` that returns 429 and an `@app.exception_handler` that turns an error into a 500 used to be invisible from the route, and so did a flask-restx service's `@app.before_request` hook and `@api.errorhandler`. Each now gets a summary of its own, `inspect` says which of them wrap the route, and the route's own transitions include theirs, each marked with where it came from. A dependency is read from the app or router construction, the decorator's `dependencies=[...]`, a parameter default and an `Annotated[...]` parameter alike, and a router's dependencies reach a route written on it from another file. A route whose whole body is one `return {"status": "ok"}` used to be reported without a response; it now reports the library's default status with that body.

**A Prisma implicit many-to-many has a boundary for its join table.** `connect`, `disconnect` and `set` through such a relation used to go unrecorded, since the join table is not in the schema. `@suss/contract-prisma` now declares that table as a boundary of its own and records those writes against it.

**A Rails action reports what it responds with, on each branch.** `render ..., status:`, `head` and `redirect_to` each set the status Rails sends, and an action that responds differently down two branches gets one transition per branch with the test that leads to it. The routes file is read for `scope`, `namespace`, `controller:`, `path:`, nested and singular resources, and a bare verb inside a resource block. A helper an action calls by its bare name is followed into its own summary, and the methods Rails gives every controller are left off the effect list, so what remains is what the action reaches in the project.

**A Python route that raises reports the status it raises with.** FastAPI's `HTTPException` and Flask's `abort` end a path with their status, so a route with a guard reports 404 under the guard and 200 under its negation. A SQLAlchemy session the handler takes as a parameter, builds with `Session()`, or gets from a helper is recognized, and a 2.0 `update(...).values(...)` is classified as a write.

**A metric's measurement words are OpenTelemetry's.** A summary now says `histogram` where it said `spread`, and `gauge`, `delta`, `cumulative` where it said `point`, `interval`, `sinceStart`. Those are the metrics data model's point kinds and aggregation temporalities, and Cloud Monitoring's own metric kinds spell the last three the same way. Summaries written before this read back with the new words, and the format is at schema version 6. Nothing needs updating by hand: no suppression rule or pack config spells these words.

**A store and a bus go by the name OpenTelemetry uses.** A summary now says `postgresql` where it said `postgres`, `aws.dynamodb` where it said `dynamodb`, `aws_sqs` where it said `sqs`, and `aws.sns` where it said `sns`, which are the values a trace gives `db.system.name` and `messaging.system`. Summaries written before this read back with the new names, so nothing published has to be regenerated, and the format is at schema version 5. Two things to update by hand: a suppression naming a bus (`bus:sqs order.placed` becomes `bus:aws_sqs order.placed`), and a `storageSystem` in pack config for `@suss/framework-sqlalchemy`, `@suss/framework-activerecord`, `@suss/framework-prisma`, or `@suss/framework-drizzle`, where `postgres` becomes `postgresql`.

**A Python route mounted through a shared framework package reports its path.** The chain many production Flask services use, an entry file handing a loader object to a library function, the loader returning a written-out list of namespaces, a loop mounting whatever comes back, is followed the whole way. That took a class becoming a value containing its methods, an argument reaching the parameter it is passed to, and imports written inside functions being read. On two measured services every route now has its full path where none did.

**A Python route reports what its body does.** Each return is a branch with its status and the conditions that reach it, and the calls a body makes are invocation effects with the conditions that gate each one. A route that declares no response keeps a transition anyway, so the work has somewhere to be recorded.

**Both languages classify database calls.** `@suss/framework-sqlalchemy` and `@suss/framework-activerecord` compose onto whichever route pack a run already uses. Python matches a query by what the method behind the call says it returns, which reads through a project's own base class; Ruby matches by what the receiver's class inherits, which reads through `ApplicationRecord`. A chain like `Model.query().filter_by(id=x).first()` is one read, saying which model, which rows (`selector`) and which columns (`fields`). A handler that hands off to a service function reports the call, and the service function's own summary reports the work, so `suss ask "what does GET /orders reach"` follows the call and `why does` says which function the work is in.

**Gap messages point at the thing.** A mounted list declined over one unmatched entry says which entry, what it resolved to, and that the rest matched. A body the path engine declines keeps its route, path and method, and says what was declined, the budget cap included.

**A handler with a run of guards reports one transition where it reported many.** Two paths that differ only over a branch they both pass through become one, in the engine, for every language. The two handlers that used to lose everything to the path budget no longer come near it.

## If you contribute to suss

**A pack declares the calls that respond, and the adapter walks them.** `responseStatusCalls` on a Ruby `controllerActions` pattern or a Python route pattern says which calls end the request and where each takes its status. The adapter hands every one to the shared path engine as a terminal and builds one branch per path, the same walk the TypeScript adapter has always done, so a status reading and the effects that reach a branch come out per branch. `ambiguousReading` is gone from the Ruby adapter with nothing left to produce it.

**Each protocol says which of its words are OpenTelemetry's.** A boundary protocol module declares `semconv`, the attribute each identity field goes under, and `semconvAttributes(binding)` reads a binding as the attributes a span would state. A field is in that projection only when our value is the value a span gets, so `storage.accessPath`, a `"default"` scope, and a `"*"` REST method stay out of it. Protocols nobody crosses at run time, `function-call` and `metric` among them, declare an empty mapping, and the compiler makes a new protocol answer the question. [Boundary semantics](/boundary-semantics#where-the-words-come-from) has the table.

**Every adapter runs the same fact contract.** `@suss/resolution` ships six executable cases stating how a fact has to be keyed, each adapter supplies its own source per case, and none declares a known gap. The kit caught three bugs on its first Ruby run that had already been fixed in Python and never carried across, and one mistake in itself.

**The rule profiler is the tool for slow extractions.** A CPU profile bottoms out at `unify` and `lookup` and cannot say which rule asked for the work; `profileEvaluationAsync` charges time and tuples to each rule. It found a join that derived 30k demand tuples to produce 224 rows, and an index that built a string out of every node id on every lookup. The measured extract went from 25.2s to 4.2s across three changes, and three plausible optimisations were measured slower and written down so nobody redoes them.

**Containment with inheritance is its own relation.** Deriving into `holdsProperty` turns a stated fact into a derived one and the on-demand rewrite gates it behind demand nothing generates. `contains` reads `holdsProperty` and adds what a base class declares.

**A version bump no longer breaks the workspace.** `preparePublish` left sibling `devDependencies` pinned at the old version, so npm fetched them from the registry instead of linking the workspace. They are `*` now.

**A new package has a checklist.** The coverage list, the packages table, the doc counts, a LICENSE force-added past the gitignore rule, and a trusted publisher on npm before the release workflow can push it, bootstrapped with a prerelease under a non-latest tag.
