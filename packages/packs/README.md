# @suss/packs

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Every pack suss ships, as one package with a subpath per pack.

```bash
npm install --save-dev @suss/packs
```

Each pack has its own subpath, and the subpath is the name that
`suss extract -f` takes:

```ts
import mongoose from "@suss/packs/mongoose";
import express from "@suss/packs/express";
```

The CLI resolves `-f mongoose` to `@suss/packs/mongoose` itself, so you
do not need an import to run `suss`.

## Why one package

npm issues a publishing credential through a trusted publisher, and each
package has to configure its trusted publisher by hand on npmjs.com.
With one package that setup happens once for every pack. Adding a pack
takes a directory and a line in the exports map.

The packs have no dependencies outside `@suss/*`, and together they come
to about 1.2 MB, so splitting them up would save nothing.
