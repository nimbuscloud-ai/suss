# @suss/framework-nextjs

Framework pack for [Next.js](https://nextjs.org/) route handlers. Next.js
puts the route in the tree rather than in a registration call, so this
pack finds handlers by where their file sits and reads the route out of
the path to it.

## What this package is

`@suss/framework-nextjs` returns a `PatternPack` object describing:

- **Discovery** by file convention: `app/**/route.ts` exporting `GET`,
  `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`, and
  `pages/api/**` exporting a default handler
- **Routes** from the path: `app/api/orders/[id]/route.ts` answers
  `/api/orders/{id}`, a directory in parentheses groups files without
  appearing in the URL, and a catch-all is named after its parameter
- **Terminals**: `NextResponse.json`, `Response.json`,
  `NextResponse.redirect`, `res.status(n).json(body)` in a pages
  handler, and `throw`
- **Input mapping**: the request first, the route context second

A route here pairs with a client calling the same URL, and with a
provider in another framework serving it, since `/api/orders/{id}` and
`/api/orders/:id` compare equal.

## What it does not cover yet

- **Server actions.** A `"use server"` function is reached through a
  compiler-generated ID rather than a URL, so there is no boundary to
  pair it on.
- **Pairing a pages handler.** One default export answers every method
  and switches on `req.method` inside, so the pack reports the path and
  leaves the method blank. A summary with no method does not pair with
  a caller, so those routes show up in an inventory and stop there.
- **Page components.** `@suss/framework-react` already reads those.
- **A route a library serves.** NextAuth's route file is
  `export { GET, POST } from "@/auth"`, where those names come out of
  destructuring the library's own return. No function in the project
  answers that route, so nothing is reported for it.

## Where it sits in suss

Depends only on `@suss/extractor` (for the `PatternPack` type). Contains
no analysis logic.

## Coverage

![coverage](../../../.github/badges/coverage-nextjs.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/framework-packs.md`](../../../docs/framework-packs.md).
