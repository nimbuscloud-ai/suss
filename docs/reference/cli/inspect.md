---
title: suss inspect
description: Print what summaries say as text, diff two of them to see what a change did, and follow a request hop by hop with --flow.
---

# `suss inspect`

`suss inspect` renders a summary file as text you can read. Run it to see what suss made of your code, to compare two extractions and see what a change did, or to follow one request through your routing hop by hop.

```
# The project in the working directory, read first
suss inspect [--types]

# One summary file
suss inspect <summaries.json> [--types]

# How the summaries in a folder pair up
suss inspect --dir <directory> [--types]

# What moved between two summary files
suss inspect --diff <before.json> <after.json> [--json] [--changed-files <path>]
             [--budget <n>] [--chain <n|full>]

# Who serves one request, hop by hop
suss inspect --flow "<METHOD> <url>" [<summaries.json> | --dir <directory>]
             [--entry <name>] [--scope <document>] [--json]
```

Given nothing, `inspect` reads the project it is run in: every entry in `suss.json`, or what `init` would pick when there is no file, into a temporary folder, then renders each file it produced. It prints the commands it ran to stderr.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | none | Report how the summaries in a folder pair up, boundary by boundary, and which ones found nothing to pair with. It does not render the summaries themselves. |
| `--diff <before> <after>` | none | Compare two summary files and report what moved. See [below](#reading-a-diff). |
| `--types` | off | Spell out the named types a summary references instead of printing their names. Applies to one file and to `--dir`; a `--diff` run ignores it. |
| `--json` | off | With `--diff` or `--flow`, write the answer as JSON. Every other form refuses it, because the file it reads is already JSON. |
| `--changed-files <path>` | none | With `--diff`, a file listing the paths a change touched, one per line, the format `git diff --name-only` writes. Those files come last in the report and are marked, since the reader has their diff already. |
| `--budget <n>` | unlimited | With `--diff`, how many characters the report may come to. Whole blocks are written until the next one does not fit, and what was left out is counted on the last line. |
| `--chain <n\|full>` | a few hops | With `--diff`, how many calls to print between a boundary and something it reaches. A longer chain prints its first and last call and counts the rest, as `through loadOrder -> (2 intermediate units collapsed) -> readRow`. `full` prints every call, `0` prints none. |
| `--flow "<METHOD> <url>"` | none | Work out who serves one request. See [`suss inspect --flow`](#suss-inspect-flow). |
| `--entry <name>` | the only way in | With `--flow`, which node the request comes in by, when the summaries contain more than one. |
| `--scope <document>` | none | With `--flow`, which document's node, when two documents declare that name. |

## Example

```
$ suss inspect summaries/api.json
fixtures/express/handlers.ts
├─ GET /users/{id}  (express handler | line 17)
│      if  !req.params.id
│        -> 400 { error }
│      elif  !db.findById()
│        -> 404 { error }
│          + db.findById
│      elif  db.findById().role === "admin"
│        -> 200 { id, name, role, admin }
│          + db.findById
│      else
│        -> 200 { id, name, role }
│          + db.findById
│
│    Could not follow:
│      The call to db.findById lands on a declaration with no body, so whatever runs there is missing from this summary
│
├─ GET /old-profile  (express handler | line 42)
│      -> 302
│
├─ GET /moved  (express handler | line 47)
│      -> 301
│
└─ * /webhooks/{source}  (express handler | line 55)
       -> 202 { accepted }
         + Promise.all

4 summaries.
```

## Reading a diff

`--diff` reports what the code now does differently. Add a comment to a file and the transitions come out at new offsets, but the diff prints nothing, because the line a handler starts on has nothing to do with how it behaves.

```
$ suss inspect --diff before.json after.json
1 boundary changed: 3 outcomes.

~ serves GET /report  src/server.ts::get  (3 outcomes)
  outcomes
    + responds 404 { error }  when  !readReport()
    + responds 200 { report }  otherwise
    - responds 200 { report }  otherwise

Changes by file

src/server.ts
  ~ get
```

The first line counts what moved. Then comes a block per boundary, with up to two groups under it: `outcomes` for what the boundary returns and under what test, and `effects` for what a request now reaches, or stopped reaching, through the calls it makes.

A path whose body moved under the same status and the same test prints as one line with a marker on each field: `{ id, ~total: string -> number, +currency: string, -email }`. Anything else prints as a `~ was` line and a `now` line. `otherwise` marks the path taken when none of the tests above it matched.

When several boundaries got the same outcome from one wrapper, the report prints it once under a `From <wrapper>` heading, with how many of the boundaries that wrapper runs on have that outcome and which ones are missing it. The files whose units moved come last.

`--diff --json` writes `{ version, changed, summaries, boundaries, causes }`. `summaries` has an entry for each summary that moved, marked `added`, `removed` or `changed`, and a changed one has its added, removed and changed transitions written out in full.

`boundaries` and `causes` contain what the printed report lists. The text and the JSON come from the same comparison of the two files, so they list the same boundaries and put the same lines under a wrapper. `boundaries` has one entry for each boundary block, `{ change, does, boundary, unit, file, outcomes, effects }`:

```json
{
  "change": "changed",
  "does": "serves",
  "boundary": "GET /orders/{id}",
  "unit": "show",
  "file": "src/routes.ts",
  "outcomes": [{ "change": "added", "outcome": "responds 404  when  !order" }],
  "effects": [
    {
      "change": "added",
      "effect": "writes postgresql:audit_log",
      "relation": "writes",
      "boundary": "postgresql:audit_log",
      "through": ["recordAudit"]
    }
  ]
}
```

Each outcome is `{ change, outcome }`. When the text prints a changed outcome as a `was` line and a `now` line, the entry also has `was`. When those two lines read the same because only a field the line leaves out moved, it has `fields` too, each with its old and new value. An outcome that came from a wrapper also has `from`, the wrapper's `{ file, name }`.

Each effect is `{ change, effect, through }`. An effect at a boundary also has `relation` and `boundary`, and `detail` for the variable a config read takes. `through` lists every call between the boundary's unit and the unit that has the effect, and it is empty when the boundary's unit has the effect itself. The `outcome` and `effect` strings are the words the text prints, so a program should match on `relation` and `boundary` rather than parse them.

`causes` has one entry per line printed under a `From <wrapper>` heading: `{ from, change, outcome, at, notAt, covered }`. `at` lists the boundaries that got the line, `notAt` the ones the wrapper runs on that did not, and `covered` how many it runs on. The line is left out of the `outcomes` of each boundary in `at`, and a boundary with nothing else left is left out of `boundaries`, as it is from the text.

The JSON ignores `--budget` and `--chain`, and it lists every outcome of a boundary that came or went, where the text lists the first few. A field added to this output keeps `version` at 1. Renaming or removing one would change it.

## `suss inspect --flow`

You give `--flow` a request, and it works out which code ends up serving it and prints the chain of hops that get it there.

`--flow` walks the routing a set of summaries declares, hop by hop. It needs the wiring and the code, so point it at a folder containing both: a deploy template read with [`suss contract`](/reference/cli/contract) for the wiring, and [`suss extract`](/reference/cli/extract) over the code for the handlers that respond.

```
$ suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir summaries/
GET https://shop.example.com/api/orders/123
in by ShopAlb, declared in cloudformation:fixtures/aws-alb/template.yaml

What serves it, as the declarations settle it:

  ShopAlb
    -> ShopHttpsListener   ShopHttpsListener belongs to ShopAlb
    -> OrdersTargetGroup   OrdersListenerRule takes it (priority 10; path-pattern /api/orders/*)
    -> OrdersTaskDefinition/orders-app   OrdersTargetGroup fronts it
  OrdersTaskDefinition/orders-app serves it
    all answers it: * /api/orders/*   (src/orders-app/middleware/dispatch.ts)
```

A bare path works too (`"GET /api/orders/123"`). With no host in the request, suss cannot evaluate a host-header rule, and the output shows where the walk stopped because of it.

The answer marks how certain each hop is. A hop whose rule takes the request outright is certain. A hop gated on something the declarations leave open, such as an unevaluated condition field or a tie between two rules, is only possible. suss puts the chain containing that hop under its own heading and points at the hop it could not decide.

When nothing serves the request, the answer tells you where the walk stopped. That might be the response a listener's own default action gives it, or the last node the walk reached together with the rules there that refused the request, or a rule that took the request and sent it somewhere suss could not resolve. In that last case the output shows the reference the document wrote and why the reader stopped, such as a target that another template declares.

If the wiring branches wider than the answer prints, the output ends with how many chains were left out.

Two documents that both declare a listener called `HttpListener` are two different listeners, and one listener's rules never apply to a request that came in through the other. Ask about a name they share and suss refuses, listing the documents it found. Add `--entry HttpListener --scope cloudformation:services/beta/template.yaml` to tell it which stack you meant.

`--flow --json` writes `{ request, entry, chains, omitted }`. Each chain is `{ entry, hops, end, certainty }`, and each hop is `{ from, to, edge, certainty }` plus a `match` describing the rule that admitted it.

## Reading the output

Summaries group by source file, and within each group they render in source order with elbow and pipe decoration, so you can see at a glance that two summaries came out of the same file.

Read the output in this order: the file path, the header line for each summary, the branch tree, the effect lines under each output, and the `→` markers pointing at other summaries.

### Header line

```
├─ <name>  (<recognition> <kind> | line N [| <metadata>])
```

| Field | What it means |
|---|---|
| `<name>` | `METHOD /path` for a REST endpoint, `<package>::<exportPath>` for a package export, the bare function name otherwise. A generic or colliding name is path-qualified (`app/routes/_app.tsx.loader`). |
| `<recognition>` | Which pack produced this summary: `react`, `react-router`, `ts-rest`, `reachable`, and so on. |
| `<kind>` | The behavioral role: `handler`, `loader`, `action`, `component`, `library`, `caller`, `client`, `useEffect`. See [IR types](/reference/ir). |
| `line N` | The source line the function starts on. |
| `<metadata>` | Kind-specific, and optional. `useEffect` shows its dependency array (`[user, prefs]`, `(mount)`, `(every render)`). `confidence: medium` appears when confidence is not high. |

### Branch tree

Each branch reads like an `if` in source:

```
    if  <predicate>
      -> <output>
    elif  <predicate>
      -> <output>
    else
      -> <output>
```

`if`, `elif` and `else` mirror the source, and a nested branch indents further. Predicates render as JavaScript-like expressions (`!params.id`, `db.findById().status === 200`), with a prefix shared across siblings collapsed so each branch shows only the predicate that decides it.

Outputs come after `-> `:

- `-> 200 { id, name, email }` for a REST response: the status, then the body shape. `{ ... }` records show their keys, `[...]` are arrays, primitives print as `string` / `int` / `bool` / `null`, and a union joins with `|`.
- `-> return <shape>` for a function return, or `-> return` alone when it returns nothing.
- `-> throw <ExceptionType>`, with the constructor name when suss knows it.
- `-> render` followed by an indented JSX-style subtree, for React component output. A self-closing leaf (`<X />`) collapses inline; an element with children expands to open and close tags.
- `-> delegate -> <target>`, `-> emit "<event>"`, and `-> void`.

An `elif` line with nothing under it means the decision tree walked past that predicate and the leaf turned up deeper inside a nested `if`. The branch in your source does have something in it.

### Effect lines

Under each output, a line starting with `+ ` records what that branch also does on the way, such as a call or a state change.

```
        -> return { files }
          + logger.info
          + getFiles →
          + + app/util/vcs.fetchFromVcs →
```

| Line | What it means |
|---|---|
| `+ <callee>` | A plain call. With no marker, the callee is not a separate summary to navigate to. |
| `+ <callee> →` | A follow reference: the callee resolves to another summary in the same file. |
| `+ <path/file>.<callee> →` | A cross-file follow reference, the path shown without its extension. |
| `+ <Parent>.effect#N →` | A sub-unit reference. A React component with `useEffect(...)` calls splits into the component's own summary and one per effect body, and the parent's effect line points at `effect#0`, `effect#1` and so on. |

A summary longer than about 50 body lines re-emits a compact `↳ <file> (cont.)` marker every 50 lines, so the file context stays in view.

### Annotations starting with `!!`

| What you see | What it means |
|---|---|
| A top-level `!! <description>` | A gap: the declared contract says a status exists but no branch produces it, or a branch produces a status the contract does not declare. |
| A trailing `!! undeclared` on an output | That output's status code is not in the declared contract for this endpoint. |

## Format stability

`inspect` output is meant to be read by a person. If you want to feed what suss extracted into another program, read the summary JSON instead. `inspect` only renders that JSON, and [Summary format](/reference/summary-format) has its stability guarantees.

Within v0, these parts of the rendering stay put across minor versions:

- Grouping by source file, each summary under its file's path header.
- The header line layout, `<name>  (<recognition> <kind> | line N [| <metadata>])`.
- The branch tree keywords `if` / `elif` / `else`, with `-> ` in front of each output.
- The output prefixes `-> <status>`, `-> return`, `-> throw`, `-> render`, `-> delegate`, `-> emit`, `-> void`.
- The effect prefix `+ ` for a call and `+ + ` for a cross-file reference.
- The `→` follow marker, and the `!!` annotations.

These change without warning: the tree-decoration characters (`├─`, `└─`, `│`), whitespace and column alignment, predicate rendering (operator precedence, parenthesization, identifier truncation), which `<metadata>` fields appear and in what order, the continuation marker text, line-wrap thresholds, and colour codes.

[Exit codes](/reference/cli/exit-codes) lists what `inspect` returns to the shell.
