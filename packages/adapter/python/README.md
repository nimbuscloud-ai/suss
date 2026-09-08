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

How each of those is decided, and where it stops: [how the Python adapter reads a project](./DESIGN.md).

## Where it fits

It depends on `@suss/extractor`, `@suss/behavioral-ir`, `@suss/datalog` and `web-tree-sitter`. The `fastapi`, `flask-restx` and `sqlalchemy` packs consume its `PythonPack` contract, and nothing here knows what any particular library's decorators are called.

`grammar/tree-sitter-python.wasm` is a checked-in binary, not a build output. [Where it comes from](./grammar/README.md).

## More

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Python and Ruby](https://nimbuscloud-ai.github.io/suss/guides/python-and-ruby)
- [Every pack suss ships](https://nimbuscloud-ai.github.io/suss/reference/packages)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-python.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
