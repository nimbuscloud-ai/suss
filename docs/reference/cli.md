# CLI reference

Every command, every flag. For prose-style usage see the
[tutorial](/tutorial/get-started) and [how-to guides](/guides/add-to-project).

Placeholder notation: `<...>` marks a required value, `[...]` marks
optional. Example: `suss extract -f FRAMEWORK [-o OUTPUT]`.

## What each command is for

suss has four commands. They form one pipeline:

| Command | Inputs | Output | When you reach for it |
|---|---|---|---|
| `extract` | TypeScript source + a framework pack | `BehavioralSummary[]` JSON | You have code and want a structured description of every execution path. |
| `contract` | A specification (OpenAPI, CFN, Storybook, ...) | `BehavioralSummary[]` JSON | You have a spec instead of code, or want to compare code against a spec. Contract summaries have the same shape as `extract`'s output, so they pair against extracted summaries. |
| `check` | One or more summary files | Findings (text or JSON) | You have summaries from two sides of a boundary, provider + consumer, contract + handler, and want to know where they disagree. |
| `inspect` | A summary file | Human-readable text | You want to read what the summaries say without parsing JSON. The output is the form you paste into a code review or an AI prompt. |

The summary JSON is the canonical artifact. `inspect` is a renderer
over it; `check` is a comparator. Anything you can do in `inspect` or
`check` you can also do by reading the JSON yourself, they're
conveniences, not parsing layers.

Two more commands sit outside the pipeline. `suss init` works out which
packs your project needs and offers to set them up. `suss corroborate`
(experimental, [below](#suss-corroborate-experimental)) executes handlers
against their own summaries.

## `suss init`

Work out which packs this project needs, then offer to install them.

**What it does.** Reads `package.json`, looks for schemas and deploy
templates on disk, and maps what it finds to packs. Then it asks whether
to install them, whether to run the first extract and check, and whether
to write a `.sussignore` and a CI workflow. Installing defaults to yes;
writing files defaults to no. Nothing reaches disk unless you accept it.

At a monorepo root it reads the workspace declaration from
`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`, or
`turbo.json`, and asks which packages to set up.

```
suss init [DIRECTORY] [--plain]
```

| Flag | Description |
|---|---|
| `DIRECTORY` | Where to look. Default: the current directory. |
| `--plain` | Print the commands instead of asking. Piped or in CI, it prints either way. |

### Exit codes

`0`, always. Declining every question, cancelling, and a failed install
all end the same way. A failed install stops there, prints what npm said,
and leaves the command behind for you to retry.

## `suss extract`

Extract behavioral summaries from TypeScript source.

**What it does.** Walks every function the framework pack discovers
(`loader` in React Router, `app.get(...)` in Express, etc.), folds
its branches and terminals into a decision tree, and emits one
`BehavioralSummary` per discovered unit. No runtime. No
annotations.

```
suss extract [-p TSCONFIG | --dir DIR] -f FRAMEWORK [-f FRAMEWORK ...]
             [-o OUTPUT] [--files FILE ...]
             [--gaps strict|permissive|silent]
             [--explain] [--timing] [--no-cache] [--fail-on-empty]
```

| Flag | Required | Description |
|---|---|---|
| `-f`, `--framework NAME` | yes | Pack name. Repeatable. See [built-in packs](#built-in-packs) below. Anything else resolves as `@suss/framework-NAME`. |
| `-p`, `--project PATH` | no | Path to `tsconfig.json`, for the same type resolution your compiler sees. Leave it off and suss uses the nearest tsconfig or jsconfig above the working directory. |
| `--dir PATH` | no | Read this directory directly, for a project with no tsconfig. |
| `-o`, `--output PATH` | no | Write JSON to file. Default: stdout. Parent dirs created automatically. |
| `--files F1 F2 ...` | no | Scope extraction to specific files. Default: every file in the tsconfig. Paths are resolved relative to cwd. |
| `--gaps MODE` | no | `permissive` (default) records gaps in the summary: returns and declared statuses the pack couldn't account for. `strict` records the same gaps, then exits non-zero if the run recorded any. `silent` skips gap detection entirely, recording none. |
| `--explain` | no | Print the extraction funnel, file by file and pack by pack, so you can see where summaries came from. A run that produced nothing prints it either way. |
| `--timing` | no | Print the per-phase wall-clock breakdown to stderr. |
| `--no-cache` | no | Skip the on-disk extraction cache for this run. Normal runs benefit from it; reach for this when debugging cache invalidation. |
| `--fail-on-empty` | no | Exit non-zero when the run produces no summaries. Worth turning on in CI, where a silent zero looks the same as a passing check. |
| `--fail-on-pack-error` | no | Exit non-zero when a pack throws while it reads. By default the run reports the throw and continues with the other packs. |

### Built-in packs

`-f NAME` accepts these out of the box:

| Name | Package | What it discovers |
|---|---|---|
| `ts-rest` | `@suss/framework-ts-rest` | ts-rest routers + contracts; handlers and clients derive method/path from the contract |
| `express` | `@suss/framework-express` | `app.get(...)` / `router.get(...)` style registration |
| `fastify` | `@suss/framework-fastify` | `fastify.get(...)` / equivalent Fastify handlers |
| `hono` | `@suss/framework-hono` | `app.get(...)` Hono handlers, including `c.json(body, status)` |
| `nextjs` | `@suss/framework-nextjs` | Next.js route handlers and pages; the route comes from where the file sits |
| `nestjs-rest` | `@suss/framework-nestjs-rest` | NestJS REST controllers (`@Controller` / `@Get`) |
| `nestjs-graphql` | `@suss/framework-nestjs-graphql` | NestJS GraphQL resolvers (`@Resolver` / `@Query` / `@Mutation`) |
| `apollo` | `@suss/framework-apollo` | Apollo Server code-first resolvers (`new ApolloServer({ typeDefs, resolvers })`) |
| `aws-lambda` | `@suss/framework-aws-lambda` | AWS Lambda HTTP handlers, paired to SAM / CloudFormation-declared routes |
| `react` | `@suss/framework-react` | Function components + locally-authored event handlers + `useEffect` bodies |
| `react-router` | `@suss/framework-react-router` | React Router v6+ `loader` / `action` named exports |
| `fetch` | `@suss/client-web` | Global `fetch(...)` call sites |
| `axios` | `@suss/client-axios` | axios call sites + `axios.create` factories |
| `apollo-client` | `@suss/client-apollo` | `@apollo/client` hooks + imperative `client.query` / `mutate` |
| `node` | `@suss/runtime-node` | `setTimeout` and friends, the `process` surface including `process.env.X`, module-loading globals |

Four more packs ship and resolve by the same `@suss/framework-NAME`
convention rather than being listed above. They discover no units of
their own; they attach typed effects to calls inside whatever units
another pack found:

| Name | Package | What it recognizes |
|---|---|---|
| `prisma` | `@suss/framework-prisma` | Prisma client calls, as storage-access interactions |
| `drizzle` | `@suss/framework-drizzle` | Drizzle query-builder and relational-query calls, with SQL table names |
| `aws-sqs` | `@suss/framework-aws-sqs` | AWS SDK v3 SQS producer calls, as message-send interactions |
| `aws-eventbridge` | `@suss/framework-aws-eventbridge` | EventBridge `PutEvents` calls, as message-bus interactions |

Your own packs work the same way. Install `@suss/framework-mypack` and
`-f mypack` resolves it.

### Configuring a pack

Write `-f <pack>=<config.json>` and the file's contents go to the pack
as its options. Each pack documents what it accepts; the CLI passes the
JSON through without reading it.

The message-bus packs use this to learn a project's own dispatcher. A
service that sends every message through a wrapper writes no
`SendMessageCommand`, so the pack sees nothing until it is told which
call to read:

```json
{
  "producers": [
    {
      "module": "@acme/async",
      "receiver": "CommandDispatcher",
      "method": "dispatch",
      "subjectArg": 0,
      "bodyArg": 1
    }
  ]
}
```

`module` is where the dispatcher's type is declared, `receiver` is that
type's name, `method` is the call that sends, and the two indexes say
which argument carries the subject and which carries the body. Leave
`bodyArg` out for a batch method that takes a list of entries. Run it
with `-f aws-sqs=packs/sqs.json`.

The subject becomes the channel the producer sends on, so it pairs with
the handler that names the same subject. A subject the source does not
state as a string yields no effect at all: pairing on a guessed channel
would name the wrong consumer.

Several other packs take a project's own wrappers the same way. A pack
ships only what its own library defines, and these options are what a
project uses when the adapter cannot follow the wrapper itself.

Reach for them second. A NestJS decorator written in the project is
already recognized without being named, because the adapter resolves it
to the function behind it and sees that calling it calls `@Resolver()`
or `@Controller()`. What is left for these options is a wrapper whose
body is not in the project, so there is nothing to read.

| Pack | Option | What it names |
| --- | --- | --- |
| `nestjs-rest` | `classDecorators` | Decorators composing `@Controller()` the adapter cannot follow |
| `nestjs-graphql` | `classDecorators` | Decorators composing `@Resolver()` the adapter cannot follow |
| `react-router` | `errorHelpers` | Helpers a loader throws HTTP errors through |
| `aws-lambda` | `subjectFactories` | The config property a project's handler factory states its subject under |

```json
{ "classDecorators": ["WidgetController", "InternalController"] }
```

```json
{
  "subjectFactories": [{ "property": "subject" }]
}
```

`property` is the key the factory's config object states the subject
under. Which function was called and which argument carried the config
are questions the adapter answers by following the export back to the
call that built it, so neither has to be named. Add `callees` or
`argIndex` when two factories in one service put different things under
the same property.

### Exit codes

- `0`: extraction succeeded (regardless of how many summaries emerged) and none of `--fail-on-empty`, `--fail-on-pack-error`, or `--gaps strict` found something to fail on.
- Non-zero: extraction threw (invalid tsconfig, unknown framework, missing files), or one of those flags fired.

## `suss contract`

Generate summaries from a declared contract instead of from code.

**What it does.** Reads a specification (OpenAPI, CloudFormation,
Storybook stories, AppSync schema) and emits the same
`BehavioralSummary` shape that `extract` produces. The point isn't
"render the spec as JSON", it's "produce a summary with declared
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
suss contract --from SOURCE SPEC [-o OUTPUT]
```

`SPEC` is either a local file path or an `http(s)` URL. When a URL is
given, the document is fetched, written to a temp file, and parsed
the same way as a local spec, useful for vendor specs hosted on
GitHub or a docs site, e.g.
`https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml`.
The fetched extension drives parser selection (`.json` → JSON, anything
else including no extension → YAML).

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
| `graphql` | `@suss/contract-graphql` | Plain GraphQL SDL file. Each Query / Mutation / Subscription field becomes a resolver-kind summary. |
| `graphql-documents` | `@suss/contract-graphql` | Committed `.graphql` / `.gql` operation documents, a single file or a directory walked recursively. Each query / mutation / subscription becomes a client-kind summary, so a repo that keeps its operations in files pairs against its resolvers without any call site being traced. Fragment spreads are inlined across the whole read set. |

Team-authored intent specs are not a `--from` source. They are their own
artifact stream, read straight by `suss check`:

```bash
suss check --dir summaries/ --intent intent/
```

### Exit codes

- `0`: contract source loaded.
- Non-zero, unknown source, file not found, parse error.

## `suss check`

Pair providers with consumers and report cross-boundary findings.

**What it does.** Reads summary files, groups them into
provider/consumer pairs by their boundary key (e.g. `(GET,
/users/:id)`), and runs each pair through a set of agreement
checks: does every status the provider produces have a consumer
branch that handles it? Does every status the contract declares
have a producer? Are the body shapes structurally compatible?

The "two sides of a boundary" framing is general:
- **Two extracted summaries**: handler vs. fetch client.
- **A contract vs. an extracted summary**, OpenAPI spec vs. handler;
  Storybook story vs. component.
- **Two contracts**, OpenAPI vs. CloudFormation, when both describe
  the same API.

A finding always names the boundary, the two sides, and what
disagrees. There's no global "compliance score", every finding is
a concrete pair.

```
# Two explicit summary files
suss check PROVIDER.json CONSUMER.json [--json] [-o OUTPUT] [--fail-on THRESHOLD]

# A whole directory, auto-pairs by boundary key
suss check --dir DIR [--intent INTENT_DIR] [--json] [-o OUTPUT]
           [--fail-on THRESHOLD] [--sussignore PATH] [--no-suppressions]
```

| Flag | Description |
|---|---|
| `--dir PATH` | Directory containing summary JSON files. suss reads every `.json` in the dir and auto-pairs by boundary. Mutually exclusive with positional args. |
| `--intent PATH` | Directory of team-authored intent docs (`*.intent.yaml`, `*.intent.yml`, `*.intent.json`, and the same three for `*.prd`). Each boundary intent is paired against the summaries in `--dir`, adding intent-coverage findings to the report. Needs `--dir`. |
| `--json` | Emit findings as JSON rather than human-readable text. Default: human text. |
| `-o`, `--output PATH` | Write findings to file. Default: stdout. |
| `--fail-on THRESHOLD` | `error` (default), exit non-zero when any error-severity finding exists. `warning`, also fail on warnings. `info`, fail on any finding. `none`, never fail (still prints). |
| `--sussignore PATH` | Use this `.sussignore` file instead of searching for one nearby. |
| `--no-suppressions` | Report every finding, ignoring any `.sussignore`. Useful for auditing what the suppressions are hiding. |

A finding that points at one transition prints a `.sussignore` rule for
it, ready to paste under `rules:`. The rule names the transition on
whichever side carries it, so it matches that finding and no other. See
[Suppressions](/suppressions).

### Exit codes

- `0`: no findings at or above the threshold (after suppressions).
- `1`: at least one finding at or above the threshold.

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
paste into a code review or an AI prompt, short enough to share,
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
| `--types` | Spell out the named types a summary references instead of printing their names. |

No JSON output mode, `inspect` is always human-formatted. For
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

1. **The file path**, what file these summaries come from.
2. **The header line** for each summary, what's summarized and
   what kind it is.
3. **The branch tree**, every execution path's condition and
   output.
4. **The effect lines** under each output, what the path calls
   into.
5. **The `→` markers**, pointers to other summaries you can
   navigate to for detail.

#### Header line

```
├─ <name>  (<recognition> <kind> | line N [| <metadata>])
```

| Field | Meaning |
|---|---|
| `<name>` | Identity. `METHOD /path` for REST endpoints; `<package>::<exportPath>` for package exports; bare function name otherwise. Generic / colliding names get path-qualified (`app/routes/_app.tsx.loader`). |
| `<recognition>` | Which discovery variant produced this summary, `react`, `react-router`, `ts-rest`, `reachable`, etc. Tells you *why* this thing is here. |
| `<kind>` | Behavioral role, `handler`, `loader`, `action`, `component`, `library`, `caller`, `client`, `useEffect`, ... See [`ir-reference.md`](/ir-reference). |
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
leaf lives deeper inside a nested `if`. Not an empty source
branch.

#### Effect lines

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

#### Continuation markers

Long summaries (more than ~50 body lines) re-emit a compact
`↳ <file> (cont.)` marker every 50 lines. This keeps the file
context within view when the file-group header has scrolled
past. Short summaries are unaffected.

#### Annotations that start with `!!`

| Shape | Means |
|---|---|
| Top-level `!! <description>` | A gap, the declared contract says a status exists but no branch produces it, or a branch produces a status the contract doesn't declare. |
| Trailing `!! undeclared` on an output | That output's status code isn't in the declared contract for this endpoint. |

### Format stability

`inspect` output is curated for human and AI reading, not for parsing.
If you need to programmatically consume what suss extracted, read the
summary JSON directly, `inspect` is a renderer over it, and the JSON
is the canonical artifact. See [behavioral summary format](/behavioral-summary-format)
for the JSON's own stability guarantees.

Within v0, `inspect` commits to keeping these shapes intact across
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

### Exit codes

- `0`: rendered successfully.
- Non-zero, input file missing or not valid summary JSON.

## `suss corroborate` (experimental)

Extract, then run each handler against its own claims.

**What it does.** Runs a normal extraction, then for every summary in
scope: generates request inputs that satisfy a transition's own
extracted conditions, executes the real handler function in a sandbox
with a stub response object, and compares the observed status with
the claimed one. Verdicts land on
`transition.confidence.corroboration`:

- `observed`: every satisfying run produced the claimed status.
- `refuted`: some run produced a different status. The concrete
  counterexample (request, observed status, claimed status) is
  attached and printed. Either the extraction is wrong there or the
  code surprises its own summary, and both are findings.
- `untested`: no satisfying input was found, or every run hit a
  dependency the sandbox cannot supply (a database, another service).
  The claim keeps its static confidence.

**Scope today** (why the flag is mandatory): `handler` summaries
recognized by the express or fastify packs, and only claims with a
literal status code. Everything else is skipped untouched. The scope
and the report format will change as coverage grows.

```
suss corroborate --experimental -p TSCONFIG -f express [-o ANNOTATED.json]
```

| Flag | Description |
|---|---|
| `--experimental` | Required. Acknowledges the command is early. |
| `-p, --project PATH` | tsconfig covering the code to read. Same resolution as `extract`. |
| `--dir PATH` | Directory to read when there is no tsconfig. |
| `-f, --framework NAME` | Pack to use. Repeatable, same names as `extract`. |
| `--runs N` | Verdict-producing executions to aim for per claim (default 25). |
| `--attempts N` | Sampling attempts per claim before giving up (default 300). |
| `-o, --output PATH` | Write the annotated summaries to a file. |

### Exit codes

- `0`: every claim that could be tried held up (or nothing was in scope).
- Non-zero: at least one claim was refuted by execution.

## Top-level flags

| Flag | Description |
|---|---|
| `-h`, `--help` | Print usage and exit 0. |

## Environment variables

None. All behavior is configured via flags.

## Where each command writes

| Target | Default |
|---|---|
| stdout | Summary JSON (`extract`, `contract`), human text (`inspect`, `check`), finding JSON (`check --json`) |
| stderr | "Wrote N summaries to PATH" acknowledgements, extraction warnings, error messages |
| exit code | Per-command threshold as described above |

Output destinations are composable: `suss extract ... -o file.json` writes
summaries to the file AND a one-line acknowledgement to stderr.
`suss check ... -o findings.txt` writes the formatted report to the file,
nothing to stdout. Piping (`suss extract ... | jq '...'`) works because
non-`-o` mode writes JSON to stdout with nothing else.
