# python-source-roots

The same two-file FastAPI app, repeated once for each way a Python
project can declare that its package lives below the repository root.
`main.py` mounts the router from `routes.py` with an absolute import, so
the route only gets its full path, `/orders/{order_id}`, when that
import resolves.

- `setuptools-package-dir`: `[tool.setuptools] package-dir` maps the
  root package to `lib/`.
- `setuptools-find`: `[tool.setuptools.packages.find] where` lists `lib`.
- `hatch`: `[tool.hatch.build.targets.wheel] packages` lists `lib/orders`.
- `poetry`: `[tool.poetry] packages` includes `orders` from `lib`.
- `plain-src`: no declaration, and the package is under `src/`.
- `unreadable-toml`: a `pyproject.toml` that sets one key twice, which
  every TOML reader rejects, with the package under `src/`. The run
  still finds `src/`, and reports which file it could not read.

The projects with a declaration use `lib/`, so finding the route proves
that suss read the declaration. A run that fell back to `src/` would
miss it.
