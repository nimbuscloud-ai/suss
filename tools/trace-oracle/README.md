# @suss/trace-oracle

This tool measures how many of the reaches a running app makes suss also
records. It runs an app's own test suite under OpenTelemetry, turns each
request in the trace into edges from its route to the tables, outbound
hosts and message destinations the request reached, and asks suss what
each of those routes reaches. Every edge suss misses gets a reason.

A trace only covers the paths the tests ran. So the number is recall on
exercised paths, and it says nothing about precision. A boundary suss
reaches from an exercised route that no request reached is listed as not
exercised.

## Run it

Recording and reporting are two steps. `record` starts an OTLP receiver
on localhost, runs the command, and writes every span the command exports
to a file, one OTLP JSON request per line, which is the format the
Collector's file exporter writes:

```sh
npx tsx tools/trace-oracle/src/cli.ts record --out spans.jsonl <command...>
```

The command loads its own language's instrumentation. The recorder sets
`OTEL_EXPORTER_OTLP_ENDPOINT` and the batch settings, and the stock OTLP
exporter does the rest.

- **Node.** Install `@opentelemetry/auto-instrumentations-node` in a
  folder of its own, then run the app with
  `TRACE_ORACLE_OTEL=<that folder> node --import tools/trace-oracle/src/nodePreload.mjs ...`.
  The preload registers the ESM loader hook as well, since an ESM app's
  imports never pass through `require`.
- **Python.** Install `opentelemetry-distro`,
  `opentelemetry-exporter-otlp-proto-http` and the instrumentations the app
  needs into its virtualenv, then run `opentelemetry-instrument python -m pytest`.
- **Ruby.** Add `opentelemetry-sdk`, `opentelemetry-exporter-otlp` and
  `opentelemetry-instrumentation-all` to the Gemfile and configure them
  with `use_all` in an initializer. The sqlite3 driver has no
  instrumentation, so subscribe to `sql.active_record` with
  `OpenTelemetry::Instrumentation::ActiveSupport.subscribe` and map the
  payload to `db.system.name` and `db.query.text`.

Then compare the spans with the app's summaries:

```sh
npx tsx tools/trace-oracle/src/cli.ts report --app <name> --spans spans.jsonl \
  --summaries <dir of suss extract output> --source <app source dir> \
  [--resource process.command_args=run.js] [--entry "^GET "] \
  --json report.json --markdown report.md
```

`--resource` keeps only the requests whose resource attribute contains
the text, for a run that also traced a helper server. `--entry` keeps
only routes whose `METHOD route` matches.

## From spans to edges

The mapping reads only semantic convention attributes, in their old and
new spellings, so it does not depend on the language.

- A request is a server span with `http.route` and `http.request.method`
  (or `http.method`). Rails' optional `(.:format)` is dropped.
- A database reach is any span below it with `db.system.name` (or
  `db.system`). The table is `db.collection.name`, `db.sql.table`, or every
  table `@suss/sql` reads out of `db.query.text` or `db.statement`.
- An outbound HTTP reach is a client span with a method and
  `server.address`, with `url.template` or the URL's path.
- A messaging reach is a producer span with `messaging.destination.name`.

A reach belongs to the nearest server span above it, so a request that
calls another service in the same trace keeps that service's reaches
apart. Spans the report sets aside are counted by why: no request above
them, a statement with no table, a read of the database's own catalog.

## The join

Routes join on suss's own route identity: the methods agree and the
paths have the same `pathShape`, so `:id`, `{id}` and `{item_id}` are one
segment. A route that only overlaps a suss route falls back to
`routePathsMeet`. For each joined route the report asks
`what does <route> reach` through `answerQuestion`, the function behind
`suss ask`.

A reached boundary agrees with a traced edge through `semconvAttributes`,
the projection suss keeps for joining a summary with a trace. Two
allowances are counted in the report. A store's system has several
spellings (`postgres`, `postgresql`). And an ORM pack records the model
while a span records the table, so `Story` agrees with `stories` and
`HiddenStory` with `hidden_stories`.

## Why an edge was missed

Each missed edge gets the first reason that fits. The order is the
ranking, since an earlier cause hides every later one.

1. **Route not discovered.** No suss route agrees with the request's route.
2. **No pack for the library.** No unit in the run crosses a boundary of
   that kind on that store.
3. **The table name not settled.** The request's own path gave the table,
   so only a hole could stand for it. This is also the reason when no unit
   in the run touches the table by name and the route reaches an access
   with no container.
4. **Dynamic dispatch.** The walk from the route meets a call with more
   than one candidate, and the call has the name of a function that
   touches the table.
5. **Wrapper or factory not read.** A function that serves no route of its
   own touches the table, and no call chain from the route leads to it.
6. **Other**, split three ways: every span of the edge ran while a
   template rendered (ActionView and Jinja2 write a span for it); only
   other routes touch the table, so the ORM loaded it on its own; or
   nothing in the run touches the table at all.

A rule that guesses is worse than `other`, so each rule needs a fact from
the trace or the summaries. A dispatch site with an unrelated name does
not make a miss dynamic dispatch.

## The rival and the ceiling

The trace is the ceiling. The rival is grep: for each traced edge, does
the route's handler file mention the table, host or destination, by the
same name rule suss gets? The handler file comes from the span when the
instrumentation says where the handler is (`code.namespace`), from the
files suss lists for the route and its wrappers, and otherwise from a
search for the line that registers the route's last fixed segment.
