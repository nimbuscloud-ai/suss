# How the extractor assembles a summary

This document covers three parts of `@suss/extractor`: how wrappers fold into a unit, which branch an effect belongs to, and how the extraction cache decides what to reuse. The [README](./README.md) says what the package is for.

## Composing the wrappers around a unit

What a route does on the wire includes more than its own body. Middleware, error handlers and validation hooks produce responses for the route without appearing in it. Before composition, a service whose auth middleware returned 401 looked as if every route disagreed with its contract.

A wrapper is a meta-function: it takes a unit and returns a unit. Once you know which call is the continuation, the wrapper's own body shows what it does, so the adapter reads the call to that parameter as a `delegate` terminal. A path through the wrapper that reaches the continuation hands control to the wrapped unit. A path that ends first responds on its own.

```
composed = the wrapper's short circuits
         + the wrapped unit's own transitions
```

A pass-through contributes nothing. It passes the request on without responding, so the unit's own outcomes already describe what a caller gets on that path, and what the wrapper did along the way is in the wrapper's own summary. The earlier design paired every pass-through with every outcome of the unit. On an app with ten branching filters in front of every route, that turned each route into a summary of hundreds of transitions. They repeated every filter's effects, and all of them described the same two outcomes.

`composeWrappers` applies this across all the summaries in a run. It reads the `wrappers` metadata a unit records, finds each wrapper's summary by file and name, and lists their responses outermost first, in the order `mw1(mw2(handler))` reads. A wrapper the framework only calls on a throw goes last, and its responses are listed when some path through the unit ends by throwing. Every transition a wrapper contributed records which wrapper under `wrappers.from`, so a reader asking why a route returns 401 lands in the middleware.

For everything else, a reader follows the chain in `wrappers.applied`. The effects along a whole request come from the wrapper summaries the chain points at. Those are what `inspect` prints under `Reaches:` and what `inspect --diff` compares. The CLI records a `wraps` call fact for each link, so the same reach walk that follows a call out of a route also follows the framework's call into a filter. Counting effects there counts each filter once, however many routes it covers.

Composition does not read the following:

- **Anything after the continuation returns.** A middleware that inspects the response on the way back out is read up to the `next()` call and no further.
- **A wrapper whose continuation the pack does not declare, or whose call the walk cannot see.** There is no record of where control passes on, so every outcome the wrapper has is listed, including the ones that would have been pass-throughs.
- **A throw the walk never saw.** An error handler's responses are listed on the routes that some path throws out of. A route whose 500 comes from a call the walk could not follow therefore still does not report 500 as a transition. The contract comparison below is the one place that counts it anyway.
- **Registration order against route order.** A wrapper registered after a route still applies to it.

### The declared contract, compared again

`assembleSummary` compares a route's declared responses with its own body. It records a gap for each status that is declared but never produced, or produced but never declared. That comparison runs before anything around the route is read. So when a contract declared the 401 that the auth middleware returns, it used to be reported once per route as declaring a status nothing produces.

`composeWrappers` runs the same comparison over the composed transitions and replaces those gaps. A status a wrapper produces counts as produced. A status the contract leaves out is reported against the wrapper by name: "requireCaller, registered around this handler, produces status 429 which is not declared in the hono contract". An error handler's responses count as produced on every route it covers, whether or not a path through the route was seen to throw, because anything the route calls can throw at runtime. A run with `gapHandling: "silent"` gets no gaps from this step either.

## Which branch an effect belongs to

An adapter finds the calls a body makes in one pass, and finds the branches separately. Something then has to decide which branch each call runs on. `guardsHoldOn` and `runsBefore` in `effectGuards.ts` make that decision, and both adapters that need it call these functions instead of keeping a copy.

A call belongs to a branch when both of these are true:

- **The branch did not record any of the call's guards the other way around.** A call inside `if (flag)` stays off every branch that recorded `!flag`. A call written above every guard has no guards, so it reaches all of the branches.
- **The call is written no later than the terminal's last line.** A call written after an early return did not run on that early return's path. The test uses the terminal's last line because `return new Promise((resolve) => resolve(read()))` runs the call inside its own expression.

Neither test is enough on its own, and ordinary code gets each one wrong.

```ts
const found = await dynamo.send(new GetItemCommand({ TableName: "Invoices" }));
if (!found.Item) {
  return { statusCode: 404, body: JSON.stringify({ error: "no invoice" }) };
}
return { statusCode: 200, body: JSON.stringify({ invoice: found.Item }) };
```

The read is under no guard, so guards alone put it on both branches, which is right. Source order alone would too. But `JSON.stringify` inside the 404 return is under `!found.Item`, and its line comes before the 200 return. Source order alone would put it on the 200 branch, where it never ran, and the guard test catches that. Now turn the example around and put the read after the 404 return. Guards alone would put it on the 404 branch, where it also never ran, and the source-order test catches that.

The first test checks whether the branch contradicts the guard. It does not require the branch to repeat the guard, because a branch often has no record of a guard at all. The path engine makes a loop opaque, so a terminal after the loop records nothing about an `if` inside the loop body. The same happens for a call inside a `catch`, or inside a callback the walk descended into. The most common case in this repo is an accumulator: a loop that pushes into an array under a condition, then returns the array. If the branch had to repeat the guard, those pushes would come off the only branch there is, and the unit would come out calling nothing at all. So when the branch is silent about a guard, the effect stays, and only a guard recorded the other way around removes it.

Guards are compared by the condition's polarity and the text it was written as, the same key a transition id is built from. An adapter therefore has to write a guard on an effect the same way it writes that guard on a branch. Otherwise the two never match, and the guard is treated as silence.

## Extraction cache

A second run over an unchanged repository returns the first run's summaries from disk, and a run after an edit re-extracts only the files the edit can affect. The TypeScript adapter keeps the cache in `.suss/cache/` beside the tsconfig, and turns it off for a project the caller supplied. `--no-cache` skips it for one run. The rest of this section describes the design.

The Python and Ruby adapters keep the same on-disk cache, rooted at `.suss/cache/` beside the project root. Neither has a config file of its own to guard an entry the way the TypeScript adapter's tsconfig does, so their key depends only on the walked file list and the packs digest. Both write an entry with no per-file attribution, so a hit today is whole-run only. Any changed file re-extracts the whole project. Per-file reuse for these two adapters is planned as a later change.

### The key

A run can only read an entry if it agrees with the run that wrote it on everything that changes what extraction produces. The name of the entry directory is a hash of these inputs:

- the cache schema version
- the adapter version, plus a content hash of the loaded adapter and analysis bundles
- each pack's name, declared version, code hash and config digest
- the project files the packs read off disk
- the extraction config (`includeReachable`, `gapHandling`)
- the config path the adapter supplies (the TypeScript adapter's tsconfig)

A pack can read project files that no walk ever sees. aws-lambda reads the SAM template that lists which handlers exist. A `packageExports` pattern reads the `package.json` whose `exports` map decides which files are on a package's boundary. Editing one of those changes what the run produces while every source file hashes the same. So a pack lists those files under `discoveryInputs`, and the key includes their paths and their content. Which files they are depends on the files the run walks, so this part of the key is computed per run, after the file list is read and before the lookup. Inside the entry, a stamp for the config path and a stamp for each project file guard the rest. A run built from source, without a bundle, has no code hash and does not use the cache at all.

### Whole reuse, then per-file reuse

The fast path compares stats alone. If the config path and every file have the same mtime and size, the previous summaries come back unchanged, with no parsing and no hashing. When stats changed, the run hashes the content of the files that changed, and a touch that changed nothing becomes a hit. When content did change, the per-file layer takes over. For every walked file, the manifest records which summaries its walk produced, wherever those summaries' functions live, and which other files that walk read. A file whose own hash and recorded reads are all unchanged gets its summaries served from the manifest. Everything else is re-extracted with the full project loaded, and the results are merged.

### What "which other files" means

Cross-file reads are recorded from several directions at once:

- The files the walked file references directly, which covers the types and helpers it imports itself. Recording the whole import closure was measured and rejected. On a repository with import cycles through its app module, one edited controller invalidated a third of the tree.
- Every file the resolution store walked, hop by hop, while answering a question asked during the file's walk. This covers re-export chains the store followed, and values wired up outside the import graph, such as an injected class constructed in another file.
- The files of every function the reachable closure entered from the file's units, plus one import hop past each, plus what the store returned during those scans.
- Export tables read and aliases resolved through the module-exports helpers, wherever the resolution landed.
- The file that claimed a unit this file's walk would otherwise have claimed, since that claim decided what this file's output leaves out.
- The mount prefixes the walk used. On every partial run they are checked again by id against the rebuilt index, so a mount added or changed in a file the router never imports still invalidates its routes.
- The packs that applied to the file. On every partial run they are checked again against the fresh gate, so a barrel that starts re-exporting a framework switches the file back to walked.

A file is not cached when one of its summaries takes part in a GraphQL join across the whole run. That happens when a summary has a document label, because schema lifting moves SDL between summaries that share one. It also happens when the summary is an operation, because client stamping writes the project's only client onto every operation. A code-first resolver does not join with anything and stays cacheable. Summaries built by passes over the whole run belong to no file and are recomputed on every partial run. Those passes are wrapper-caller expansion, library env-read markers and schema documents. Units the cache serves are left out of closure emission in the same way a cold run's seeds are, so a re-walked file that reaches a cached unit never duplicates it.

### Known gaps

A type read more than one import hop away, through a chain that no recorded mechanism followed, can change a summary's printed types without invalidating it. The middle file of a deep re-export chain has the same gap when the compiler resolved the chain and the store did not. A dependency upgrade under `node_modules` invalidates nothing, because the pack and adapter hashes stand in for knowledge of the libraries. Stage two of #422 closes these gaps by recording what each answer read, per answer.

A re-extracted summary can also be represented differently from one produced by a run without the cache. Type-shape expansion shares a memo across the run, so a run that walks five files can expand a shape to a different depth than a run that walks a thousand, and the shape digest changes with it. The summary was computed fresh either way, and nothing served is stale.

### Invalidating every entry

The schema version is part of the entry directory's name. A format change therefore makes every old entry unreachable, so it is never misread, and the eviction pass deletes it in time. `MAX_ENTRIES` limits a cache directory to two entries.
