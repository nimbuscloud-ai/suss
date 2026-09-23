# python-source-roots

The same two-file FastAPI app, once per way a Python project can say
its package lives below the repository root. `main.py` mounts the
router from `routes.py` with an absolute import, so the route only gets
its full path, `/orders/{order_id}`, when that import resolves.

- `setuptools-package-dir`: `[tool.setuptools] package-dir` maps the
  root package to `lib/`.
- `setuptools-find`: `[tool.setuptools.packages.find] where` lists `lib`.
- `hatch`: `[tool.hatch.build.targets.wheel] packages` lists `lib/orders`.
- `poetry`: `[tool.poetry] packages` includes `orders` from `lib`.
- `plain-src`: no declaration, and the package is under `src/`.
- `unreadable-toml`: a `pyproject.toml` that sets one key twice, which
  every TOML reader rejects, with the package under `src/`. The run
  still finds `src/` and says which file it could not read.

The declared projects use `lib/` so that finding the route proves the
declaration was read. A run that fell back to `src/` would miss it.
