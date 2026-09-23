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

## What it does not cover yet

- **Server actions.** A `"use server"` function is reached through an
  ID the compiler generates. It has no URL, so there is no boundary to
  pair it on.
- **Pairing a pages handler.** One default export handles every method
  and switches on `req.method` inside, so the pack reports the path and
  leaves the method blank. A summary with no method does not pair with
  a caller, so those routes show up in an inventory and go no further.
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
