# Proposal: boundaries whose behaviour lives outside the code we read

Status: draft, seeking alignment. Nothing here is implemented. These
gaps came from running the Next.js pack against two production apps and
an open-source storefront.

## The problem

Four things came back wrong or missing. The first three share one
cause.

1. **A route a library serves.** NextAuth's route file is
   `export { GET, POST } from "@/auth"`, where those names come out of
   destructuring what `NextAuth(config)` returned. Discovery finds the
   file, finds the export names, and finds no function in the project
   to read. Nothing is reported, so a reader sees a hole and cannot
   tell whether discovery missed the route or the route is not there.

2. **A response type a library defines.** A handler ending in
   `new ImageResponse(...)` from `next/og`, or
   `new StreamingTextResponse(stream)` from `ai`, matches no terminal
   any pack describes. suss now reports the unread return, which is the
   least it should do, but the handler's summary still says nothing
   about what it produces.

3. **An operation defined in data files instead of code.** The storefront
   sends every query and mutation through its own `executeGraphQL`,
   which takes a document and ends at `fetch`. Two client units stand
   in for the whole data layer. The operation name, the variables, and
   the selected fields are all in the project, in `.graphql` files, and
   none of them reach a summary.

4. **A handler that serves more than one method.** A `pages/api`
   handler is one default export that switches on `req.method`. The
   REST binding has room for a single method, so the pack reports the
   path and leaves the method blank, and the handler pairs with nothing.

## What the first three have in common

Each one is a boundary the project does have, where the thing that
would describe it is outside the function suss is reading. In 1 it is
inside a dependency. In 2 the words for the outcome belong to a
dependency. In 3 it is in a file beside the code.

We should not build three different fixes, because one mechanism we
already have covers all of them.

A contract source produces `BehavioralSummary` values from a
declaration instead of a function body. `@suss/contract-openapi`
reads a spec, `@suss/contract-cloudformation` reads a template,
`@suss/contract-appsync` reads a schema, and each stamps
`confidence: { source: "declared" }` or `"derived"` on what it emits.
The checker pairs those against code-derived summaries on boundary
identity, whichever side each one came from. We have one summary format
so that it can.

So the open question is where the description comes from when there is
no spec file.

## What is missing

**A declaration a person or a library can write.** Today a contract
source has to read some other tool's artifact. The three cases above
have no artifact to read, and the fact is knowable and stable.
NextAuth's handler serves GET and POST wherever it is mounted.
`ImageResponse` is a 200 with an image in it. `executeGraphQL` takes the
document at argument 0.

We settled the name for this already, in the note saying that renaming
`@suss/stub-*` to `@suss/contract-*` frees "stub" for interface
declarations a person can write by hand. These gaps are the first cases
that need it.

Two places the same declaration can come from:

- **In the project.** A file the config points at, for the cases
  specific to how this project is put together, and for anything a
  library has not shipped yet.
- **From the library.** A package ships its own declaration the way it
  ships its types, and installing it is enough. This is where the
  package-exports work already points: a package's exports are a
  boundary, and a provider publishes summaries alongside the code.

The library route reaches the most projects, and the project route is
how we get there. A library author adopts the format once someone has
written a declaration by hand and seen it work. The project route also
costs nothing to keep supporting.

**Marking a summary as declared.** `confidence.source` already has
`declared`. A recent change marks an empty summary `low`, so you can
tell an unread handler from a declared one, and both from one suss
read. A declared summary should not claim it was derived from the body,
and a reader should be able to ask which of their boundaries are
described by hand.

## The fourth case is a different problem

A handler that serves a set of methods is not a reading problem. The
model has one method per REST binding, and a `pages/api` handler serves
all of them. Express has the same situation with `app.all`, and
API Gateway with `ANY`, which the Lambda pack handles today by refusing
to bind such a function as a route.

There are three options, none of them free: a method set on the
binding, a synthetic unit per method the handler branches on, or
leaving it as it is and saying so. The second is closest to how the
rest of the model works, since a handler that branches on `req.method` already has the branch
conditions extracted, and each branch is a path with its own outcome.
That would let a `pages/api` handler pair method by method with the
clients calling it.

We should decide this separately from the rest of this, and decide it
before the pack claims to cover the pages router.

## Order

1. The declaration format, designed around the three cases above. Start
   with the NextAuth one, since it is the smallest: a boundary, a
   method, and no behaviour claimed.
2. The response-type case next, because it is the one a library author
   would most plausibly ship, and because it is the same file format
   pointed at a different question.
3. The GraphQL documents, which need the declaration to say "argument 0
   is the operation" and then need the reader that finds the document.
   This is the largest of the three, and the one with the most behind
   it.
4. Method sets, on their own, after deciding which of the three options
   is right.
