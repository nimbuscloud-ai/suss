# @suss/framework-nextjs

Framework pack for [Next.js](https://nextjs.org/) route handlers. Next.js
takes the route from the file tree, with no registration call, so this
pack finds handlers by where their file lives and reads the route from
its path.

```ts
// app/api/orders/[id]/route.ts
export async function GET(request: Request, { params }) {
  return NextResponse.json(await findOrder(params.id));
}
```

## What this package is

`@suss/framework-nextjs` exports a `PatternPack`, which is data the
adapter reads. It covers:

- **Discovery** by file convention: `app/**/route.ts` exporting `GET`,
  `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS`, and
  `pages/api/**` exporting a default handler.
- **Routes** from the path. `app/api/orders/[id]/route.ts` serves
  `/api/orders/{id}`. A directory in parentheses groups files and does
  not appear in the URL. A catch-all is named after its parameter.
- **Terminals**: `NextResponse.json`, `Response.json`,
  `NextResponse.redirect`, `res.status(n).json(body)` in a pages
  handler, and `throw`.
- **Input mapping**: the request first, the route context second.

A route found here pairs with a client that calls the same URL. It also
pairs with a provider in another framework that serves it, since
`/api/orders/{id}` and `/api/orders/:id` compare equal.

## Pages handlers and server actions

A `pages/api` handler is one default export that switches on
`req.method` inside, so it serves every method. The pack records its
method as `*`, and pairing matches it against whichever method a caller
uses.

A `"use server"` directive turns a function into an endpoint that a
client component calls as if it were local, while the runtime sends a
POST. The pack makes each such function an `action` unit, so its
summary shows what a button press runs on the server. A directive at
the top of a file makes every exported function an action. A directive
inside a function marks that function alone, exported or not.

## What it does not cover yet

- **Page components.** `@suss/framework-react` already reads those.
- **A route a library serves.** NextAuth's route file is
  `export { GET, POST } from "@/auth"`, where those names come from
  destructuring the library's own return value. No function in the
  project serves that route, so nothing is reported for it.

## Where it fits in suss

The pack depends only on `@suss/extractor`, for the `PatternPack` type.
It has no analysis logic of its own.

## Coverage

![coverage](../../../.github/badges/coverage-nextjs.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
