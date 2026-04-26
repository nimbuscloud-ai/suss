# CLI reference

Every command, every flag. For prose-style usage see the
[tutorial](/tutorial/get-started) and [how-to guides](/guides/add-to-project).

Placeholder notation: `<...>` marks a required value, `[...]` marks
optional. Example: `suss extract -p TSCONFIG -f FRAMEWORK [-o OUTPUT]`.

## What each command is for

suss has four commands. They form one pipeline:

| Command | Inputs | Output | When you reach for it |
|---|---|---|---|
| `extract` | TypeScript source + a framework pack | `BehavioralSummary[]` JSON | You have code and want a structured description of every execution path. |
| `stub` | A specification (OpenAPI, CFN, Storybook, ...) | `BehavioralSummary[]` JSON | You have a spec instead of code, or want to compare code against a spec. Stubs are summaries with the same shape as `extract`'s output, so they pair against extracted summaries. |
| `check` | One or more summary files | Findings (text or JSON) | You have summaries from two sides of a boundary — provider + consumer, contract + handler — and want to know where they disagree. |
| `inspect` | A summary file | Human-readable text | You want to read what the summaries say without parsing JSON. The output is the form you paste into a code review or an AI prompt. |

The summary JSON is the canonical artifact. `inspect` is a renderer
over it; `check` is a comparator. Anything you can do in `inspect` or
`check` you can also do by reading the JSON yourself — they're
conveniences, not parsing layers.

## `suss extract`

Extract behavioral summaries from TypeScript source.

**What it does.** Walks every function the framework pack discovers
(`loader` in React Router, `app.get(...)` in Express, etc.), folds
its branches and terminals into a decision tree, and emits one
`BehavioralSummary` per discovered unit. No runtime. No
annotations.

```
suss extract -p TSCONFIG -f FRAMEWORK [-f FRAMEWORK ...] [-o OUTPUT]
             [--files FILE ...] [--gaps strict|permissive|silent]
```

| Flag | Required | Description |
|---|---|---|
| `-p`, `--project PATH` | yes | Path to `tsconfig.json`. suss uses this to resolve types; make sure the `include` covers the files you want analyzed. |
| `-f`, `--framework NAME` | yes | Framework pack name. Repeatable. See [built-in packs](#built-in-packs) below. Custom packs resolve via the `@suss/framework-NAME` convention. |
| `-o`, `--output PATH` | no | Write JSON to file. Default: stdout. Parent dirs created automatically. |
| `--files F1 F2 ...` | no | Scope extraction to specific files. Default: every file in the tsconfig. Paths are resolved relative to cwd. |
| `--gaps MODE` | no | `strict` (default) — record gaps where conditions can't be decomposed. `permissive` — record gaps silently. `silent` — skip gap detection entirely. |

### Built-in packs

`-f NAME` accepts these out of the box:

| Name | Package | What it discovers |
|---|---|---|
| `ts-rest` | `@suss/framework-ts-rest` | ts-rest routers + contracts; handlers and clients derive method/path from the contract |
| `react-router` | `@suss/framework-react-router` | React Router v6+ `loader` / `action` named exports |
| `express` | `@suss/framework-express` | `app.get(...)` / `router.get(...)` style registration |
| `fastify` | `@suss/framework-fastify` | `fastify.get(...)` / equivalent Fastify handlers |
| `react` | `@suss/framework-react` | Function components + locally-authored event handlers + `useEffect` bodies |
| `apollo` | `@suss/framework-apollo` | Apollo Server code-first resolvers (`new ApolloServer({ typeDefs, resolvers })`) |
| `fetch` | `@suss/client-web` | Global `fetch(...)` call sites |
| `axios` | `@suss/client-axios` | axios call sites + `axios.create` factories |
| `apollo-client` | `@suss/client-apollo` | `@apollo/client` hooks + imperative `client.query` / `mutate` |

Custom packs: if you install `@suss/framework-mypack`, `-f mypack`
resolves it automatically.

### Exit codes

- `0` — extraction succeeded (regardless of how many summaries emerged).
- Non-zero — extraction threw (invalid tsconfig, unknown framework, missing files).

## `suss contract`

Generate summaries from a declared contract instead of from code.

**What it does.** Reads a specification (OpenAPI, CloudFormation,
Storybook stories, AppSync schema) and emits the same
`BehavioralSummary` shape that `extract` produces. The point isn't
"render the spec as JSON" — it's "produce a summary with declared
behavior so the cross-boundary checker can pair it with an
extracted summary the same way it would pair two extracted
summaries."

Use cases:
- A third-party API ships an OpenAPI spec. You want to verify your
  client handles every status the spec declares.
- Your CloudFormation template declares an API Gateway route. You
  want to check that the Lambda handler implements every method the
  template registers.
- A Storybook story declares the props it passes to a component.
  You want to check that the component handles every prop variant
  the stories cover.

```
suss contract --from SOURCE SPEC_PATH [-o OUTPUT]
```

| Flag | Description |
|---|---|
| `--from SOURCE` | Contract source kind. See [contract sources](#contract-sources) below. |
| `-o`, `--output PATH` | Write JSON to file. Default: stdout. |

### Contract sources

| Source | Package | Input |
|---|---|---|
| `openapi` | `@suss/contract-openapi` | OpenAPI 3.x JSON or YAML |
| `cloudformation` | `@suss/contract-cloudformation` | CFN / SAM template (JSON or YAML) with API Gateway REST / HTTP API resources |
| `storybook` | `@suss/contract-storybook` | CSF3 `.stories.ts` / `.stories.tsx` file or directory of stories |
| `appsync` | `@suss/contract-appsync` | CFN template with `AWS::AppSync::*` resources |
| `prisma` | `@suss/contract-prisma` | `schema.prisma` file (Postgres / MySQL / SQLite datasources) |

### Exit codes

- `0` — contract source loaded.
- Non-zero — unknown source, file not found, parse error.

## `suss check`

Pair providers with consumers and report cross-boundary findings.

**What it does.** Reads summary files, groups them into
provider/consumer pairs by their boundary key (e.g. `(GET,
/users/:id)`), and runs each pair through a set of agreement
checks: does every status the provider produces have a consumer
branch that handles it? Does every status the contract declares
have a producer? Are the body shapes structurally compatible?

The "two sides of a boundary" framing is general:
- **Two extracted summaries** — handler vs. fetch client.
- **A stub vs. an extracted summary** — OpenAPI spec vs. handler;
  Storybook story vs. component.
- **Two stubs** — OpenAPI vs. CloudFormation, when both describe
  the same API.

A finding always names the boundary, the two sides, and what
disagrees. There's no global "compliance score" — every finding is
a concrete pair.

```
# Two explicit summary files
suss check PROVIDER.json CONSUMER.json [--json] [-o OUTPUT] [--fail-on THRESHOLD]

# A whole directory — auto-pairs by boundary key
suss check --dir DIR [--json] [-o OUTPUT] [--fail-on THRESHOLD]
```

| Flag | Description |
|---|---|
| `--dir PATH` | Directory containing summary JSON files. suss reads every `.json` in the dir and auto-pairs by boundary. Mutually exclusive with positional args. |
| `--json` | Emit findings as JSON rather than human-readable text. Default: human text. |
| `-o`, `--output PATH` | Write findings to file. Default: stdout. |
| `--fail-on THRESHOLD` | `error` (default) — exit non-zero when any error-severity finding exists. `warning` — also fail on warnings. `info` — fail on any finding. `none` — never fail (still prints). |

### Exit codes

- `0` — no findings at or above the threshold (after suppressions).
- `1` — at least one finding at or above the threshold.

Suppressions (`.sussignore`) affect counting: `mark` and `hide`
effects don't count toward the threshold; `downgrade` counts at
the downgraded severity. See [Suppressions](/suppressions).

## `suss inspect`

Render a summary file (or directory, or diff) as human-readable
text.

**What it does.** Reads a summary JSON file and prints a tree-style
view: summaries grouped by source file, decision-tree branches
under each summary, side effects under each branch, follow-references
to other summaries inline. The output is meant to be the form you
paste into a code review or an AI prompt — short enough to share,
self-describing enough to read cold, structurally aligned with the
underlying IR.

```
# A single summary file
suss inspect SUMMARIES.json

# Every summary in a directory, grouped by boundary
suss inspect --dir DIR

# Diff two summary files (shows changed transitions)
suss inspect --diff BEFORE.json AFTER.json
```

| Flag | Description |
|---|---|
| `--dir PATH` | Render every summary in a directory, grouped by boundary with pair-discovery annotations. |
| `--diff BEFORE AFTER` | Compare two summary files and render added / removed / changed transitions. |

No JSON output mode — `inspect` is always human-formatted. For
programmatic consumption, read the summary files directly (they
ARE JSON).

### Reading the output

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

1. **The file path** — what file these summaries come from.
2. **The header line** for each summary — what's summarized and
   what kind it is.
3. **The branch tree** — every execution path's condition and
   output.
4. **The effect lines** under each output — what the path calls
   into.
5. **The `→` markers** — pointers to other summaries you can
   navigate to for detail.

#### Header line

```
├─ <name>  (<recognition> <kind> | line N [| <metadata>])
```

| Field | Meaning |
|---|---|
| `<name>` | Identity. `METHOD /path` for REST endpoints; `<package>::<exportPath>` for package exports; bare function name otherwise. Generic / colliding names get path-qualified (`app/routes/_app.tsx.loader`). |
| `<recognition>` | Which discovery variant produced this summary — `react`, `react-router`, `ts-rest`, `reachable`, etc. Tells you *why* this thing is here. |
| `<kind>` | Behavioral role — `handler`, `loader`, `action`, `component`, `library`, `caller`, `client`, `useEffect`, ... See [`ir-reference.md`](/ir-reference). |
| `line N` | Source line where the function starts. |
| `<metadata>` | Optional kind-specific suffix. `useEffect` shows its dependency array (`[user, prefs]`, `(mount)`, `(every render)`). `confidence: medium` appears when not high. |

#### Branch tree

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
  - `-> 200 { id, name, email }` — REST response, literal status,
    body shape. `{ ... }` records show keys; `[...]` are arrays;
    primitives are `string` / `int` / `bool` / `null`; unions
    join with `|`.
  - `-> return <shape>` — function return; `-> return` alone for
    empty.
  - `-> throw <ExceptionType>` — exception with the constructor
    name when known.
  - `-> render` followed by an indented JSX-style subtree — React
    component output. Self-closing leaves (`<X />`) collapse
    inline; elements with children expand to open/close tags.
  - `-> delegate -> <target>` / `-> emit "<event>"` / `-> void`.

An `elif` line with no `->` underneath it is a tree-building
artifact: the decision tree walked past that predicate but the
leaf lives deeper inside a nested `if`. Not an empty source
branch.

#### Effect lines

Under each output, lines starting with `+ ` describe what that
branch *also* does — calls invoked on the path to the terminal,
mutations, emissions, state changes:

```
        -> return { files }
          + logger.info
          + getFiles →
          + + app/util/vcs.fetchFromVcs →
```

- `+ <callee>` — a plain call. No marker means the callee isn't
  a separate summary suss can navigate to.
- `+ <callee> →` — a follow reference. The callee resolves to
  another summary in the file. Look for it nearby.
- `+ <path/file>.<callee> →` — a cross-file follow reference.
  The callee resolves to a summary in another file (path shown
  without extension); scroll to that file's group to read it.
- `+ <Parent>.effect#N →` — a sub-unit reference. React
  components with `useEffect(...)` calls split into the
  parent component's summary and one summary per effect body.
  The parent's effect line points at the `effect#0`, `effect#1`,
  ... summaries directly below it.

#### Continuation markers

Long summaries (more than ~50 body lines) re-emit a compact
`↳ <file> (cont.)` marker every 50 lines. This keeps the file
context within view when the file-group header has scrolled
past. Short summaries are unaffected.

#### Annotations that start with `!!`

| Shape | Means |
|---|---|
| Top-level `!! <description>` | A gap — the declared contract says a status exists but no branch produces it, or a branch produces a status the contract doesn't declare. |
| Trailing `!! undeclared` on an output | That output's status code isn't in the declared contract for this endpoint. |

### Format stability

`inspect` output is curated for human and AI reading, not for parsing.
If you need to programmatically consume what suss extracted, read the
summary JSON directly — `inspect` is a renderer over it, and the JSON
is the canonical artifact. See [behavioral summary format](/behavioral-summary-format)
for the JSON's own stability guarantees.

Within v0, `inspect` commits to keeping these shapes intact across
minor versions:

- **Grouping by source file**, with each summary rendered under its
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

- Exact tree-decoration characters (`├─`, `└─`, `│`) — these are
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

### Exit codes

- `0` — rendered successfully.
- Non-zero — input file missing or not valid summary JSON.

## Top-level flags

| Flag | Description |
|---|---|
| `-h`, `--help` | Print usage and exit 0. |

## Environment variables

None. All behavior is configured via flags.

## Where each command writes

| Target | Default |
|---|---|
| stdout | Summary JSON (`extract`, `stub`), human text (`inspect`, `check`), finding JSON (`check --json`) |
| stderr | "Wrote N summaries to PATH" acknowledgements, extraction warnings, error messages |
| exit code | Per-command threshold as described above |

Output destinations are composable: `suss extract ... -o file.json` writes
summaries to the file AND a one-line acknowledgement to stderr.
`suss check ... -o findings.txt` writes the formatted report to the file,
nothing to stdout. Piping (`suss extract ... | jq '...'`) works because
non-`-o` mode writes JSON to stdout with nothing else.
