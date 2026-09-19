---
title: suss inspect
description: Print what summaries say as text, diff two of them to see what a change did, and follow a request hop by hop with --flow.
---

# `suss inspect`

Render a summary file (or directory, or diff) as human-readable
text.

**What it does.** It reads a summary JSON file and prints a tree-style
view: summaries grouped by source file, decision-tree branches
under each summary, side effects under each branch, follow-references
to other summaries inline. The output is meant to be the form you
paste into a code review or an AI prompt, short enough to share,
self-describing enough to read cold, structurally aligned with the
underlying IR.

```
# The project in the current directory, read first
suss inspect

# A single summary file
suss inspect SUMMARIES.json

# Every summary in a directory, grouped by boundary
suss inspect --dir DIR

# Diff two summary files (shows changed transitions)
suss inspect --diff BEFORE.json AFTER.json [--json] [--changed-files PATH] [--budget N] [--chain N|full]

# Who serves a request, hop by hop
suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir DIR
```

Given nothing, `inspect` reads the project it is run in first: every
entry in `suss.json`, or what `init` would pick when there is no file,
into a temporary directory, then renders each file it produced the way
it renders a single summary file. It prints the commands it ran to
stderr.

| Flag | Description |
|---|---|
| `--dir PATH` | Report how the summaries in a directory pair up, boundary by boundary, and which ones found nothing to pair with. It does not render the summaries themselves. |
| `--diff BEFORE AFTER` | Compare two summary files. The first line counts what moved. An outcome several boundaries got from the same wrapper is said once under `From <wrapper>`, with how many of the boundaries it runs on have it and which ones do not. Then a block per boundary that moved: `outcomes` for what it returns and under what test, `effects` for what a request now reaches or stopped reaching through the calls it makes. A path whose body moved under the same status and the same test prints as one line with a marker on each field: `{ id, ~total: string -> number, +currency: string, -email }`. Anything else prints as a `was` line and a `now` line. `otherwise` on a line means the path taken when none of the tests above it matched. Under that, the files with units that moved, with a unit's own lines written out when there are a few of them and counted when there are more. A transition that only moved in the file is not a change, so an edit above a handler leaves the diff quiet. Takes `--json`, `--changed-files`, `--budget` and `--chain`. |
| `--changed-files PATH` | With `--diff`, a file listing the paths a change touched, one per line, the format `git diff --name-only` writes. Those files come last and are marked, since the reader has their diff already. |
| `--budget N` | With `--diff`, how many characters the report may come to. Whole blocks are written until the next one does not fit, and what was left out is counted on the last line. |
| `--chain N` | With `--diff`, how many calls to print between a boundary and something it reaches. A longer chain prints its first and last call and counts the rest, as `through loadOrder -> (2 intermediate units collapsed) -> readRow`. `--chain full` prints every call, `--chain 0` prints none. |
| `--types` | Spell out the named types a summary references instead of printing their names. It applies to a single file and to `--dir`; a `--diff` run ignores it. |
| `--flow "METHOD URL"` | Work out who serves one request, hop by hop. See [below](#suss-inspect-flow). |

Rendering a file has no JSON output mode, it is always human-formatted.
For programmatic consumption, read the summary files directly (they ARE
JSON). Two forms are different, because each works an answer out rather
than rendering a file, so there is nowhere else to read it from.
`--flow` takes `--json` and gives you the chain as data. `--diff` takes
it and gives you what moved between two runs, as
`{ version, changed, summaries }` with each entry marked `added`,
`removed`, or `changed`.

A diff reports behaviour. Two runs over the same code with a comment
added produce transitions at different offsets and the diff says
nothing, because where a handler is in a file is not something it does.

## `suss inspect --flow`

Ask who serves a request, and get the chain back.

**What it does.** It walks the routing a set of summaries declares, hop
by hop. It then tells you the entry the request came in by, every hop it
took and the rule that admitted that hop, the unit it lands in, and the
handler inside that unit.

It reads both sides of the question, so point it at a directory
containing both: a deploy template read with `suss contract` for the
wiring, and `suss extract` over the code for the handlers that respond.

```
suss inspect --flow "<METHOD URL>" [SUMMARIES.json | --dir DIR]
```

Asking the ALB fixture who serves an order lookup:

```
suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir summaries/
```

```
GET https://shop.example.com/api/orders/123
in by ShopAlb, declared in cloudformation:fixtures/aws-alb/template.yaml

What serves it, as the declarations settle it:

  ShopAlb
    -> ShopHttpsListener   ShopHttpsListener belongs to ShopAlb
    -> OrdersTargetGroup   OrdersListenerRule takes it (priority 10; path-pattern /api/orders/*)
    -> OrdersTaskDefinition/orders-app   OrdersTargetGroup fronts it
  OrdersTaskDefinition/orders-app serves it
    allOrders answers it: * /api/orders/*   (src/orders-app/app.ts)
```

| Flag | Description |
|---|---|
| `--flow "METHOD URL"` | The request to ask about. A path works too (`"GET /api/orders/123"`), and then suss cannot settle a host-header rule, and it says so. |
| `--dir PATH` | Read every summary file in a directory, instead of the one file given as an argument. |
| `--entry NAME` | Which node the request comes in by, when the summaries contain more than one way in. |
| `--scope DOCUMENT` | Which document's node, when two documents declare that name. |
| `--json` | Write the chains as JSON instead of prose. |

You can see how certain each answer is, and a possible answer is never
presented as a settled one. A hop whose rule takes the request outright
is certain. A hop gated on something the declarations leave open, an
unevaluated condition field or a tie between two rules, is only
possible, and suss groups the chain containing it under its own heading
and says which hop is unsettled.

When nothing serves the request, the answer says where the walk
stopped. That is the response a listener's own default action gives it,
or the last node the walk reached along with the rules declared there
that refused the request, or a rule that took the request and sent it
somewhere nothing here resolved. In that last case the output shows the
reference the document wrote and the reason the reader stopped (a target
another template declares, for instance).

If the wiring branches wider than the answer prints, the output ends
with how many chains were left out, so you never mistake a partial
answer for the whole of it. The JSON form has the same count under
`omitted`.

Two documents that both declare a listener called `HttpListener` are
two listeners, and neither one's rules may be used for the other's
question. If you ask about a name they share, suss refuses and lists the
documents, so
`--entry HttpListener --scope cloudformation:services/beta/template.yaml`
says which stack you meant.

## Reading the output

Summaries group by source file. Within each group, summaries
render in source-order with elbow / pipe tree decoration so the
relationship "these two summaries live in the same file" is
visible at a glance.

```
app/routes/_bff.architecture.containers.$id.files.ts
├─ loader  (react-router loader | line 14)
│      if  !args.params.id
│        -> 400
│      elif  !prismaClient.containerV2.findUnique()
│        -> 404
│      else
│        -> return { files }
│          + logger.info
│          + getFiles →
│
├─ getAnalyzedFilesAtCommit  (reachable library | line 102)
│      -> return [{ filePath, id }]
│
└─ getFiles  (reachable library | line 124)
       -> return [{ id, filePath }]
         + getAnalyzedFilesAtCommit →
```

Five things to read for, in order:

1. **The file path**, what file these summaries come from.
2. **The header line** for each summary, what's summarized and
   what kind it is.
3. **The branch tree**, every execution path's condition and
   output.
4. **The effect lines** under each output, what the path calls
   into.
5. **The `→` markers**, pointers to other summaries you can
   navigate to for detail.

### Header line

```
├─ <name>  (<recognition> <kind> | line N [| <metadata>])
```

| Field | Meaning |
|---|---|
| `<name>` | Identity. `METHOD /path` for REST endpoints; `<package>::<exportPath>` for package exports; bare function name otherwise. Generic / colliding names get path-qualified (`app/routes/_app.tsx.loader`). |
| `<recognition>` | Which discovery variant produced this summary, `react`, `react-router`, `ts-rest`, `reachable`, etc. Tells you *why* this thing is here. |
| `<kind>` | Behavioral role, `handler`, `loader`, `action`, `component`, `library`, `caller`, `client`, `useEffect`, ... See [IR types](/reference/ir). |
| `line N` | Source line where the function starts. |
| `<metadata>` | Optional kind-specific suffix. `useEffect` shows its dependency array (`[user, prefs]`, `(mount)`, `(every render)`). `confidence: medium` appears when not high. |

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

- `if` / `elif` / `else` mirror the source. Nested branches indent
  further.
- **Predicates** render as JavaScript-like expressions:
  `!params.id`, `user.deletedAt`, `db.findById().status === 200`.
  Shared prefixes across siblings are collapsed so each branch
  shows only the predicate that decides it.
- **Outputs** appear after `-> `:
  - `-> 200 { id, name, email }`, REST response, literal status,
    body shape. `{ ... }` records show keys; `[...]` are arrays;
    primitives are `string` / `int` / `bool` / `null`; unions
    join with `|`.
  - `-> return <shape>`: function return; `-> return` alone for
    empty.
  - `-> throw <ExceptionType>`: exception with the constructor
    name when known.
  - `-> render` followed by an indented JSX-style subtree, React
    component output. Self-closing leaves (`<X />`) collapse
    inline; elements with children expand to open/close tags.
  - `-> delegate -> <target>` / `-> emit "<event>"` / `-> void`.

An `elif` line with no `->` underneath it is a tree-building
artifact: the decision tree walked past that predicate but the
leaf lives deeper inside a nested `if`. It is not an empty source
branch.

### Effect lines

Under each output, lines starting with `+ ` describe what that
branch *also* does, calls invoked on the path to the terminal,
mutations, emissions, state changes:

```
        -> return { files }
          + logger.info
          + getFiles →
          + + app/util/vcs.fetchFromVcs →
```

- `+ <callee>`: a plain call. No marker means the callee isn't
  a separate summary suss can navigate to.
- `+ <callee> →`: a follow reference. The callee resolves to
  another summary in the file. Look for it nearby.
- `+ <path/file>.<callee> →`: a cross-file follow reference.
  The callee resolves to a summary in another file (path shown
  without extension); scroll to that file's group to read it.
- `+ <Parent>.effect#N →`: a sub-unit reference. React
  components with `useEffect(...)` calls split into the
  parent component's summary and one summary per effect body.
  The parent's effect line points at the `effect#0`, `effect#1`,
  ... summaries directly below it.

### Continuation markers

Long summaries (more than ~50 body lines) re-emit a compact
`↳ <file> (cont.)` marker every 50 lines. This keeps the file
context within view when the file-group header has scrolled
past. Short summaries are unaffected.

### Annotations that start with `!!`

| What you see | What it means |
|---|---|
| Top-level `!! <description>` | A gap, the declared contract says a status exists but no branch produces it, or a branch produces a status the contract doesn't declare. |
| Trailing `!! undeclared` on an output | That output's status code isn't in the declared contract for this endpoint. |

## Format stability

`inspect` output is curated for human and AI reading, not for parsing.
If you need to programmatically consume what suss extracted, read the
summary JSON directly, `inspect` is a renderer over it, and the JSON
is the canonical artifact. See [Summary format](/reference/summary-format)
for the JSON's own stability guarantees.

Within v0, `inspect` promises to keep these parts unchanged across
minor versions:

- **Grouping by source file**: with each summary rendered under its
  file's path header.
- **Header line layout**: `<name>  (<recognition> <kind> | line N [| <metadata>])`.
- **Branch tree keywords**: `if` / `elif` / `else`, with `-> ` prefixing
  each output.
- **Output prefixes**: `-> <status>`, `-> return`, `-> throw`, `-> render`,
  `-> delegate`, `-> emit`, `-> void`.
- **Effect prefix**: lines under an output begin with `+ ` for calls
  and `+ + ` for cross-file references.
- **Follow markers**: `→` after a callee name signals another summary
  exists for it.
- **`!!` annotations** for gaps and `undeclared` outputs.

Free to change without warning:

- Exact tree-decoration characters (`├─`, `└─`, `│`), these are
  cosmetic and may shift to align with other tools.
- Whitespace, indentation widths, column alignment.
- Predicate rendering style (operator precedence, parenthesization,
  identifier truncation rules).
- The exact `<metadata>` suffix on the header line, including which
  fields appear and in what order.
- Continuation marker text (`↳ <file> (cont.)`).
- Trailing-whitespace behavior, line-wrap thresholds, color codes.

If your tooling regexes any of the "free to change" items, expect it
to break. If you find yourself reaching for parsing, reach for the
summary JSON instead.

[Exit codes](/reference/cli/exit-codes#suss-inspect) says what `inspect`
returns to the shell.

