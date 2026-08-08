# grammar/

`tree-sitter-ruby.wasm` is the compiled Ruby grammar for
[web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter). It is
a checked-in binary asset, not a build output: `src/parser.ts` loads it
by path at run time (`Language.load(...)`), the same way the Python
adapter's grammar asset works.

The adapter depends only on `web-tree-sitter` (pure WASM, no native
bindings, no install script). It does not depend on the
`tree-sitter-ruby` npm package as a runtime dependency, because that
package's `install` script runs `node-gyp-build` to load a native
binding, which is unnecessary here and the kind of native-toolchain
surface the language-adapters proposal rules out. This file is the one
part of that package v0 actually needs, taken out on its own.

Provenance, so a grammar bump is a deliberate, checkable act:

- Source: `tree-sitter-ruby` npm package, version `0.23.1`.
- File: `tree-sitter-ruby.wasm` from the package root (built by that
  package's own `tree-sitter build --wasm`, published pre-built).
- SHA-256: `09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4`.

tree-sitter-ruby is MIT-licensed. [`NOTICE`](./NOTICE) in this
directory reproduces its copyright and permission notice in full, and
ships in the published tarball alongside the `.wasm` file (both live
under `grammar/`, which the package's `files` field includes), so the
attribution its license requires travels with the binary it covers.

To pick up a newer grammar: `npm pack tree-sitter-ruby@<version>`,
extract it, copy `tree-sitter-ruby.wasm` here, update the version and
hash above, check `NOTICE` still matches that version's `LICENSE` file,
and re-run the adapter's test suite. A grammar change that renames or
restructures a node type used in `src/ast.ts` or `src/scope.ts` will
fail loudly there.
