# @suss/adapter-python

Read a Python codebase with [suss](https://github.com/nimbuscloud-ai/suss).

suss reads both sides of every call in a repository and says where the two disagree: a client asking for a field the route stopped returning, a status nobody handles, a queue with no consumer. It reads the code itself, with no model and no network. This package is the part that reads Python: it parses with tree-sitter, binds names the way Python does, and writes down what each route declares and what each handler reaches.

## Install

```bash
npm install --save-dev @suss/cli
```

The adapter ships inside the CLI, so there is nothing else to install.

## Read a FastAPI service

```bash
npx suss extract --lang python -f fastapi -f sqlalchemy -f requests -o summaries/python.json
npx suss check --dir summaries/
```

`suss init` reads your requirements file or pyproject and writes those two commands out for your own project.

## What it reads

- FastAPI and flask-restx routes, including a decorator a project re-exports through a wrapper module, with `response_model` and `status_code` taken as the declared contract.
- The path a route is served under, composed through `include_router` prefixes, however many mounts deep, including a mount written inside a function or spread out of a dictionary.
- SQLAlchemy calls, `requests` / `httpx` / `aiohttp` call sites, what a file reads from the environment, and what a handler calls out to, as facts the checker's rules run over.
- A statement the project wrote as SQL, whether it goes to a function the library exports, as SQLAlchemy's `text` does, or to a method on a client object the library handed the project. The statement reads through the value evaluator, so an f-string or a table name kept in another module's constant reads the same as one written out at the call.
- Environment reads written through a project helper: with `def env(key): return os.environ[key]`, a call to `env("DATABASE_URL")` is a read of `DATABASE_URL`, however many helpers the name is handed through on the way. The helper can be what a factory returned, as in `env = make_reader()`, and it can read through an environment object it was handed, as in `make_reader(os.environ)` giving back `lambda name: env[name]`. Not covered: a name built with an f-string (`env(f"{prefix}_URL")`), a name the helper takes off a dict, and a helper built by `functools.partial`.

How each of those is decided, and where it stops: [how the Python adapter reads a project](./DESIGN.md).

## Reading a value

Nothing outside the facility reads a node's text to find out what a value is. `values/evaluator.ts` is the evaluator: `evaluatedValue` runs the statements ahead of an expression and says what it comes to, and `stringValueOf` gives the string when it settles to one, so a path built out of an f-string or a module constant reads the same as one written out. `facts/resolve.ts` says where a name came from, with `writtenValueOf` and `originsOf`, and the literal readers in `ast.ts` (`stringLiteralValue`, `booleanLiteralValue`) are for the places a literal really is written out. When one of them cannot read a spelling, the case goes into the evaluator's lowering or the resolution rules; `npm run check:readers` at the repo root fails on a reader written beside a call site instead. [`design/docs-internal/style.md#reading-a-value`](../../../design/docs-internal/style.md#reading-a-value) has the rule.

## Where it fits

It depends on `@suss/extractor`, `@suss/behavioral-ir`, `@suss/datalog` and `web-tree-sitter`. The `fastapi`, `flask-restx` and `sqlalchemy` packs consume its `PythonPack` contract, and nothing here knows what any particular library's decorators are called.

`grammar/tree-sitter-python.wasm` is a checked-in binary, not a build output. [Where it comes from](./grammar/README.md).

## More

- [Documentation](https://suss.sh/)
- [Python and Ruby](https://suss.sh/guides/python-and-ruby)
- [Every pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-python.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
