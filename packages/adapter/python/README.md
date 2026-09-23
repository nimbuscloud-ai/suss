# @suss/adapter-python

Read a Python codebase with [suss](https://github.com/nimbuscloud-ai/suss).

suss reads both sides of every call in a repository and reports where the two disagree, for example a client asking for a field the route stopped returning, or a status nobody handles. It reads the code itself, without a model or network access. This package reads Python. It parses with tree-sitter, binds names the way Python does, and records what each route declares and what each handler reaches.

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

- FastAPI and flask-restx routes, including a decorator a project re-exports through a wrapper module. It takes `response_model` and `status_code` as the declared contract.
- The path a route is served under. It composes `include_router` prefixes through any number of mounts, including a mount written inside a function or spread out of a dictionary.
- SQLAlchemy calls, `requests` / `httpx` / `aiohttp` call sites, what a file reads from the environment, and what a handler calls out to. These are recorded as facts that the checker's rules run over.
- A statement the project wrote as SQL. The statement can go to a function the library exports, as with SQLAlchemy's `text`, or to a method on a client object the library gave the project. The value evaluator reads the statement, so an f-string, or a table name kept in another module's constant, reads the same as one written out at the call.
- Environment reads written through a project helper. With `def env(key): return os.environ[key]`, a call to `env("DATABASE_URL")` is a read of `DATABASE_URL`, however many helpers the name passes through on the way. The helper can be what a factory returned, as in `env = make_reader()`. It can also read through an environment object it received, as when `make_reader(os.environ)` returns `lambda name: env[name]`. Three cases are not covered: a name built with an f-string (`env(f"{prefix}_URL")`), a name the helper takes off a dict, and a helper built by `functools.partial`.

How each of those is decided, and where it stops: [how the Python adapter reads a project](./DESIGN.md).

## Reading a value

Code outside the facility never reads a node's text to find out what a value is. `values/evaluator.ts` is the evaluator. `evaluatedValue` runs the statements ahead of an expression and returns what it comes to. `stringValueOf` returns the string when the value settles to one, so a path built out of an f-string or a module constant reads the same as one written out. `facts/resolve.ts` works out where a name came from, with `writtenValueOf` and `originsOf`. The literal readers in `ast.ts` (`stringLiteralValue`, `booleanLiteralValue`) are for the places where a literal is written out in the source. When one of them cannot read a spelling, add the case to the evaluator's lowering or to the resolution rules. `npm run check:readers` at the repo root fails on a reader written beside a call site instead. [`design/docs-internal/style.md#reading-a-value`](../../../design/docs-internal/style.md#reading-a-value) has the rule.

## Where it fits

It depends on `@suss/extractor`, `@suss/behavioral-ir`, `@suss/datalog` and `web-tree-sitter`. The `fastapi`, `flask-restx` and `sqlalchemy` packs consume its `PythonPack` contract. Nothing in this package hardcodes what a particular library's decorators are called.

`grammar/tree-sitter-python.wasm` is a checked-in binary, and the build does not produce it. [Where it comes from](./grammar/README.md).

## More

- [Documentation](https://suss.sh/)
- [Python and Ruby](https://suss.sh/guides/python-and-ruby)
- [Every pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-python.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
