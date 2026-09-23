# grammar/

`tree-sitter-python.wasm` is the compiled Python grammar for
[web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter). It is
a binary checked into the repository, and the build does not produce
it. `src/parser.ts` loads it by path at run time (`Language.load(...)`),
so the file has to exist on disk next to the compiled adapter. This is
the same way `web-tree-sitter` ships its own core `.wasm` next to its JS.

The adapter depends only on `web-tree-sitter`, which is pure WASM with
no native bindings and no install script. It does not depend on the
`tree-sitter-python` npm package. That package's `install` script runs
`node-gyp-build` to load a native binding, which this adapter does not
need, and the language-adapters proposal rules out that kind of native
toolchain dependency. This file is the one part of that package v0
needs, copied out on its own.

The provenance is recorded here so that a grammar bump is a deliberate
change someone can check:

- Source: `tree-sitter-python` npm package, version `0.23.6`.
- File: `tree-sitter-python.wasm` from the package root (built by that
  package's own `tree-sitter build --wasm`, published pre-built).
- SHA-256: `8c93692fb368e288a5824cee55773c9b3602804f513bda48c97661e52e9c2da2`.

tree-sitter-python is MIT-licensed. [`NOTICE`](./NOTICE) in this
directory reproduces its copyright and permission notice in full. It
ships in the published tarball alongside the `.wasm` file, because both
live under `grammar/`, which the package's `files` field includes. The
attribution its license requires therefore travels with the binary it
covers.

To pick up a newer grammar, run `npm pack tree-sitter-python@<version>`
and extract it. Copy `tree-sitter-python.wasm` here, update the version
and hash above, check that `NOTICE` still matches that version's
`LICENSE` file, and re-run the adapter's test suite. A grammar change
that renames or restructures a node type used in `src/ast.ts` will fail
loudly there. Over the longer term, the fuzzer's parse-failure-rate
reporting (per the language-adapters proposal) is the signal for when a
bump is needed.
