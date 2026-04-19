# CLI reference

Every command, every flag. For prose-style usage see the
[tutorial](/tutorial/get-started) and [how-to guides](/guides/add-to-project).

Placeholder notation: `<...>` marks a required value, `[...]` marks
optional. Example: `suss extract -p TSCONFIG -f FRAMEWORK [-o OUTPUT]`.

## `suss extract`

Extract behavioral summaries from TypeScript source.

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
| `fetch` | `@suss/runtime-web` | Global `fetch(...)` call sites |
| `axios` | `@suss/runtime-axios` | axios call sites + `axios.create` factories |
| `apollo-client` | `@suss/runtime-apollo-client` | `@apollo/client` hooks + imperative `client.query` / `mutate` |

Custom packs: if you install `@suss/framework-mypack`, `-f mypack`
resolves it automatically.

### Exit codes

- `0` — extraction succeeded (regardless of how many summaries emerged).
- Non-zero — extraction threw (invalid tsconfig, unknown framework, missing files).

## `suss stub`

Generate summaries from a declared contract instead of from code.

```
suss stub --from SOURCE SPEC_PATH [-o OUTPUT]
```

| Flag | Description |
|---|---|
| `--from SOURCE` | Stub source kind. See [stub sources](#stub-sources) below. |
| `-o`, `--output PATH` | Write JSON to file. Default: stdout. |

### Stub sources

| Source | Package | Input |
|---|---|---|
| `openapi` | `@suss/stub-openapi` | OpenAPI 3.x JSON or YAML |
| `cloudformation` | `@suss/stub-cloudformation` | CFN / SAM template (JSON or YAML) with API Gateway REST / HTTP API resources |
| `storybook` | `@suss/stub-storybook` | CSF3 `.stories.ts` / `.stories.tsx` file or directory of stories |
| `appsync` | `@suss/stub-appsync` | CFN template with `AWS::AppSync::*` resources |

### Exit codes

- `0` — stub succeeded.
- Non-zero — unknown source, file not found, parse error.

## `suss check`

Pair providers with consumers and report cross-boundary findings.

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

No JSON output mode — inspect is always human-formatted. For
programmatic consumption, read the summary files directly (they
ARE JSON).

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
