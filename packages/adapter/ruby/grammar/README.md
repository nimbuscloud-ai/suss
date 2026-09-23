# grammar/

`tree-sitter-ruby.wasm` is the compiled Ruby grammar for
[web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter). It is
a binary checked into the repository, and the build does not produce
it. `src/parser.ts` loads it by path at run time (`Language.load(...)`),
the same way the Python adapter loads its grammar.

The adapter depends only on `web-tree-sitter`, which is pure WASM with
no native bindings and no install script. It does not have the
`tree-sitter-ruby` npm package as a runtime dependency. That package's
`install` script runs `node-gyp-build` to load a native binding, which
this adapter does not need, and the language-adapters proposal rules out
that kind of native toolchain dependency. This file is the one part of
that package v0 needs, copied out on its own.

The provenance is recorded here so that a grammar bump is a deliberate
change someone can check:

- Source: `tree-sitter-ruby` npm package, version `0.23.1`.
- File: `tree-sitter-ruby.wasm` from the package root (built by that
  package's own `tree-sitter build --wasm`, published pre-built).
- SHA-256: `09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4`.

tree-sitter-ruby is MIT-licensed. [`NOTICE`](./NOTICE) in this
directory reproduces its copyright and permission notice in full. It
ships in the published tarball alongside the `.wasm` file, because both
live under `grammar/`, which the package's `files` field includes. The
attribution its license requires therefore travels with the binary it
covers.

To pick up a newer grammar, run `npm pack tree-sitter-ruby@<version>`
and extract it. Copy `tree-sitter-ruby.wasm` here, update the version
and hash above, check that `NOTICE` still matches that version's
`LICENSE` file, and re-run the adapter's test suite. A grammar change
that renames or restructures a node type used in `src/ast.ts` or
`src/scope.ts` will fail loudly there.
