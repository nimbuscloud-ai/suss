---
title: Work across services
description: Extract each service into one folder and check them together, so a handler in one repo and the client that calls it in another are compared against each other.
---

# Work across services

Run one `extract` per service into the same folder, then one `check` over the folder.

```bash
npx @suss/cli extract -p services/catalog/tsconfig.json -f hono -o summaries/catalog.json
npx @suss/cli extract -p apps/storefront/tsconfig.json -f fetch -o summaries/storefront.json
npx @suss/cli check --dir summaries/
```

suss pairs summaries by boundary, so it compares a handler in one service with the client that calls it in another, whichever run wrote them. Order does not matter, because `check` reads whatever is in the folder. Each team writes the extract command for its own service. The pipeline runs all of them.

## Two repos

When the two sides live in separate repositories, the provider writes its summaries to a file its repo checks in:

```bash
# in the catalog-api repo
npx @suss/cli extract -p tsconfig.json -f hono -o suss/catalog.json
git add suss/catalog.json
```

The consumer copies that file in next to its own and checks the pair:

```bash
# in the storefront repo
cp ../catalog-api/suss/catalog.json summaries/
npx @suss/cli extract -p tsconfig.json -f fetch -o summaries/storefront.json
npx @suss/cli check --dir summaries/
```

`extract` writes file paths relative to the project it read, and the format has nothing machine-specific in it, so the file means the same thing in the consumer's repo as it did in the provider's. [Publish summaries](/guides/publish-summaries) shows how to ship the file inside the package instead of copying it.

You can also pass both files, when the folder has more in it than the pair you want:

```bash
npx @suss/cli check summaries/catalog.json summaries/storefront.json
```

## When the provider stops sending a field

The catalog service used to send a discounted price and no longer does:

```ts
// catalog-api/src/api.ts
app.get("/products/:sku", async (c) => {
  const product = await lookup(c.req.param("sku"));

  if (!product) {
    return c.json({ error: "no such product" }, 404);
  }

  return c.json({ sku: product.sku, title: product.title, price: product.price });
});
```

The storefront still reads it:

```ts
// storefront/src/product.ts
export function loadProduct(sku: string) {
  return fetch(`/products/${sku}`)
    .then((res) => res.json())
    .then((product) => product.discountedPrice);
}
```

Neither repository imports the other, and no type connects them. `check` reports it anyway:

```
Compared 1 boundary.

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/product.ts::loadProduct (src/product.ts:1)
  boundary: hono (http) GET /products/:sku
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /products/{sku}"
      provider: { transitionId: "get:response:404:9cb77da" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[ERROR] misreadProviderResponse
  The consumer's fall-through path reads "discountedPrice", but the 200 body the provider sends does not include it, and neither does any other response.
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/product.ts::loadProduct (src/product.ts:1)
  boundary: hono (http) GET /products/:sku
  to silence this one, add to the rules in .sussignore.yml:
    - kind: misreadProviderResponse
      boundary: "GET /products/{sku}"
      provider: { transitionId: "get:response:200:fed8467" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
2 findings: 1 error, 1 warning, 0 info

suss met a call it could not follow in one unit, of 2, so that one is described in part. `suss inspect` says which calls.
```

The error gives a file and a line for each side, so the fix is a two-line diff in whichever repo was wrong. The warning above it comes from the same pair, seen from the other direction. The catalog service returns 404, and the storefront has no branch for it.

## Set them all up at once

At a repo root, `init` reads the workspace declaration, from `package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json` or `turbo.json`, and reports on each package under it:

```
════ services/catalog ════

✓ Found 3 things to read

  Your code
    hono             hono in dependencies
    fetch            TypeScript sources, and fetch reads what the language itself ships

  What your code reaches
    node             TypeScript sources, and node reads what the language itself ships

1. Install suss

   npm install --save-dev @suss/cli

2. Read each side into one folder

   suss extract -f hono -f fetch -f node -o summaries/code.json
```

You get one block per package, each with the extract command that package needs. Without `--plain`, `init` asks which packages to set up and then writes one `suss.json` for all of them. When the output is piped or the run is in CI, it prints the commands instead.

## Two services that serve the same path

When two services both serve `GET /users`, suss sees one boundary. A client inside one of those services is compared with its own service's route. A client anywhere else could reach either one, so `check` compares it with neither and says so:

```
[WARNING] ambiguousProvider
  web::src/users.ts::loadUsers calls GET /users, and 2 services serve it (auth, directory). Nothing here says which one it reaches, so no pair was checked. Give the client the base URL it calls, or check one service at a time.
  provider: src/api.ts::get (src/api.ts:3)
  consumer: src/users.ts::loadUsers (src/users.ts:1)
  boundary: fetch (http) GET /users
```

To compare that client, check it against one service at a time:

```bash
npx @suss/cli extract -p services/auth/tsconfig.json -f hono -o auth/api.json
cp summaries/web.json auth/
npx @suss/cli check --dir auth/
```

## A spec instead of the other side's code

`suss contract` reads a spec and writes it out in the same format as `extract`. The other side can then be an OpenAPI document, a Prisma schema or a CloudFormation template instead of code:

```bash
npx @suss/cli contract --from openapi ../catalog-api/openapi.yaml -o summaries/catalog.json
npx @suss/cli check --dir summaries/
```

In [Check against OpenAPI](/guides/check-against-openapi), suss compares the spec, the handlers behind it and the client that calls it in one run. [Contract sources](/packs/contract-sources) lists what `--from` accepts.
