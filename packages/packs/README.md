# @suss/packs

Every pack suss ships, as one package with a subpath per pack.

```bash
npm install --save-dev @suss/packs
```

A pack is reached by its own subpath, which is the name `suss extract -f`
takes:

```ts
import mongoose from "@suss/packs/mongoose";
import express from "@suss/packs/express";
```

The CLI resolves `-f mongoose` to `@suss/packs/mongoose` on its own, so
running `suss` needs no import.

## Why one package

npm exchanges a publishing credential against a trusted publisher that
each package configures for itself, by hand, on npmjs.com. One package
means that happens once rather than once per pack, so adding a pack is a
directory and a line in the exports map.

The packs have no dependencies outside `@suss/*`, and all of them
together come to about 1.2 MB, so there is nothing to save by splitting
them up.
