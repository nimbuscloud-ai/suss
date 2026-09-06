---
title: Adopting suss one step at a time
description: Six steps from reading one service to gating pull requests, with the command for each, what it tells you, what it costs, and what a false positive looks like there.
---

# Adopting suss one step at a time

Start on one service, with nothing to triage, and go further only when
the previous step paid for itself. Each step below has the command to
run, what you get from it, what it costs, and what a wrong answer looks
like at that step so you recognize one when you see it.

The steps, in order:

1. Read one service with `extract` and `inspect`.
2. Question it with `suss ask` or the MCP server.
3. Compare it against a document you already keep.
4. Add the consumer side.
5. Gate on it in CI and on pull requests.
6. Reuse the summaries.

The [second half](#where-things-live-and-who-runs-what) of this page
covers where the files go, who runs what in a repository with several
services, how a finding gets triaged, and how to tell a suss miss from
a bug in the code.

## 1. Read one service

```bash
npx @suss/cli extract -f express -f prisma -o summaries/api.json
npx @suss/cli inspect summaries/api.json
```

`-f` says which packs to read with; one for the HTTP framework and one
for the ORM covers most services. With no `-p`, suss uses the nearest
tsconfig above the working directory. A Python or Ruby service takes
`--dir` instead; see [Read a Python or Ruby
project](/guides/python-and-ruby).

**What you get.** A tree, one entry per route, with every path the
handler can take, the status and body fields on each, and the calls
and queries along the way:

```
src/api.ts
├─ GET /users/{id}  (hono handler | line 5)
│      if  !findUser()
│        -> 404 { error }
│      elif  findUser().deletedAt
│        -> 410 { error }
│      else
│        -> 200 { id, name, email }
│
│    Reaches:
│      invocation findUser
```

There are no findings at this step. The value is a description of the
service that nobody had to write, and the check that suss reads your
stack at all before you invest further.

**What it costs.** A cold run over a service of a few hundred units
takes seconds, and later runs read a per-file cache, so a run after
editing one file is faster than the first. Nothing is built or
started.

**What a wrong answer looks like.** A route with this line under it:

```
!! Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here
```

means suss found the route and could not read the handler, which is
usually a response written through a helper the pack does not know. A
`Could not follow` line under a route means one call in it landed
somewhere suss could not read, so the paths behind that call are
missing. Neither is silent. If most routes look like this, [Why a pack
found nothing](/guides/pack-health) says how to tell whether it is the
setup or the stack, and `extract --explain` prints what each pack
matched, file by file.

## 2. Question it

From the shell:

```bash
npx @suss/cli ask 'what writes postgresql:Article' --dir summaries/
npx @suss/cli ask 'what does GET /articles/:slug reach' --dir summaries/
npx @suss/cli ask 'what calls getArticle' --dir summaries/
```

From a coding agent, over MCP. `suss init` writes the `suss.json` the
server reads, and the host config is one block:

```json
{
  "mcpServers": {
    "suss": { "command": "npx", "args": ["-y", "@suss/mcp", "/path/to/project"] }
  }
}
```

The server keeps its summaries current as files change, so an answer
describes the working tree rather than whatever was last extracted.
The [MCP package](https://github.com/nimbuscloud-ai/suss/tree/main/packages/mcp)
lists the four tools.

**What you get.** File and line for every unit that reads or writes a
table, every boundary a route reaches, and every caller of a function,
followed through as many hops as the calls take. An agent that asks
before it edits a table or changes a signature knows what it is about
to affect, and a person reviewing the agent's change can ask the same
question. This is the step where a team that ships with an agent gets
the most for the least, because it needs nothing beyond step 1.

**What it costs.** Nothing beyond step 1 for the shell. The MCP server
runs one extract when it starts and re-runs the affected part when a
file changes.

**What a wrong answer looks like.** An answer that ends like this:

```
suss could not follow next, so a writer could be hiding behind it.
```

is complete as far as suss could read and says where it stopped. An
answer with no such line and a unit you know is missing is a bug in
suss or a pack; see [A suss miss or a bug](#a-suss-miss-or-a-bug)
below.

## 3. Compare it against a document you already keep

Most services already keep one document that says what they do: a
Prisma schema, a CloudFormation or SAM template, a ts-rest router, an
OpenAPI file. `suss contract` reads it into the same form as the code,
and `check` compares the two:

```bash
npx @suss/cli contract --from cloudformation template.yaml -o summaries/template.json
npx @suss/cli check --dir summaries/
```

`suss init` does the whole of this step and step 1 for you. It reads
the dependency list, looks for schemas and templates on disk, and
prints or runs the commands. It also writes `suss.json`, which later
runs read so a document that stops being compared is reported instead
of going unpaired without anybody noticing.

What compares against what, today:

- A Prisma schema against every query. The `prisma` pack reads the
  schema during `extract`, so this one needs no `contract` command.
  The schema is the provider and each query is a consumer, so a column
  no query reads or a field no model declares is a finding.
- A CloudFormation or SAM template against the Lambda code it deploys.
  The template is read during `extract`, so the routes, the queues and
  the environment variables it wires are compared against what the
  handler does with them.
- A contract written in the code, a ts-rest router or a
  `createRoute` under hono-openapi, against the handler behind it.
  `inspect` marks a declared status no path produces with a `!!` line,
  and `check` reports it.
- An OpenAPI document against the handlers it describes. A status a
  handler produces that the document leaves out is an error; a status
  the document declares that no path in the handler produces is a
  warning, since documents often declare the 401 the middleware sends.
- An OpenAPI document against the clients that call it. The document
  is the provider; see step 4 and [Pair against
  OpenAPI](/guides/pair-against-openapi).

**What you get.** The first findings. A status the handler produces
that its contract does not declare, a status the contract declares
that no path produces, a column a query writes that no query reads.
One from the Express and Prisma app on the [home page](/):

```
[WARNING] boundaryFieldUnused
  Comment declares "articleId" and code here writes to it, but no query reads it. suss counts a column as read only when a query selects it, so before you treat the write as pointless, look for code that takes "articleId" off a record it already fetched.
  provider: src/prisma/schema.prisma::Comment (src/prisma/schema.prisma:1)
  consumer: src/prisma/schema.prisma::Comment (src/prisma/schema.prisma:1)
  boundary: prisma (postgresql)
```

**What it costs.** One more command, and the first decisions. A
finding is either a bug in the code, a document that fell behind, or
something you accept, and the third kind goes in `.sussignore.yml`
with a reason so it does not come back.

**What a wrong answer looks like.** The contract declares a `401` and
suss says no path produces it. Usually the `401` comes from a
middleware or an error handler registered around the route rather
than from the handler itself. suss composes those in when it can see
the registration, and when it cannot (the middleware is built by a
call it could not follow, say) the route looks as if it never produces
the status. Accept it with a suppression rule, or open an issue with
the `inspect` output for that route; a wrapper suss cannot see is a
pack gap and gets fixed.

## 4. Add the consumer side

Read the code that calls the service into the same directory: a
frontend with a fetch or axios client, another service, a queue
consumer:

```bash
npx @suss/cli extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
npx @suss/cli check --dir summaries/
```

A client pairs with a handler when the method and the path match, so a
client in `apps/web` and a handler in `services/api` compare against
each other with nothing else declared.

**What you get.** A finding now says which caller breaks:

```
[ERROR] misreadProviderResponse
  The consumer's fall-through path reads "name", but the 200 body the provider sends does not include it, and neither does any other response.
  provider: backend/src/server.ts::get (backend/src/server.ts:14)
  consumer: frontend/src/loadUser.ts::loadUser (frontend/src/loadUser.ts:1)
  boundary: express (http) GET /users/:id
```

Before removing a field or changing a status, run this and read the
list. When the list is empty and every caller is in the repository,
the change is safe as far as the code can say.

**What it costs.** One extract per consumer, and a bigger set of
findings the first time. Expect the first run over an old codebase to
produce more than you want to read. `check --at 'GET /users/:id'`
narrows to one boundary, and the severity split (errors fail, warnings
print) is there so the first run is not all or nothing.

**What a wrong answer looks like.** `unhandledProviderCase` says a
client never branches on a status the handler produces. A client that
handles every non-2xx status in one shared interceptor handles it,
and suss reports the warning anyway when it could not follow the
interceptor to the branch. This is the most common accepted finding,
and a suppression rule scoped to the finding kind and the boundary
covers it. [Suppress a finding](/guides/suppress-findings) has the
three patterns.

## 5. Gate on it

Two things go into CI. The `inspect-diff` action reads the base and
the head of a pull request and posts what the change did to each unit
as a comment, and `check --fail-on error` fails the build on an
error-severity finding:

```yaml
- uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
  with:
    extract: -p tsconfig.json -f express -f prisma

- name: Check the boundaries
  run: npx suss check --dir summaries/ --fail-on error
```

[Set up CI checking](/guides/ci-integration) has the whole workflow,
and the action's README lists its inputs.

**What you get.** The diff is the thing a reviewer reads first on a
pull request too large to read in full:

```
handler:GET /users/{id}
  hono handler
  3 changes
    + 200 { id, status }  when  findUser() && findUser().deletedAt
    - 410 { error }  when  findUser() && findUser().deletedAt
    ~ 200 { id, name, email }  (default)
      -> 200 { id, name }  (default)
```

Three lines say that a deleted account now gets a `200` instead of a
`410` and that `email` left the response, whichever of the thousand
lines in the pull request did it. A quiet diff says the change did not
alter what any unit does, which is the answer a refactor wants.

**What it costs.** Two extracts per pull request instead of one, and
the decision of what fails the build. Start at `error`. Tighten to
`warning` when the accepted findings are all in `.sussignore.yml` and
a new warning means something.

**What a wrong answer looks like.** A diff that is quiet after a
change you know altered behavior. The changed code is behind a call
suss could not follow, and step 1's `Could not follow` line under
that route says which.

## 6. Reuse the summaries

Everything above reads one JSON file per extract, and so can anything
else:

- **Agent context.** Hand `AGENTS.md` to the agent (it ships in the
  package at `node_modules/@suss/cli/AGENTS.md`), or run the MCP
  server from step 2. The agent gets what a route does without
  reading the handler.
- **Endpoint documentation.** `inspect` output over a service is a
  description of every route, kept current by re-running it. `suss
  infer intent` drafts a behavior document from the summaries for
  people to edit.
- **Test cases.** Each path in a summary is a case a test could cover:
  the predicate is the setup and the transition is the assertion. A
  route with five paths and two tests has three uncovered.

The format is in [Summary format](/behavioral-summary-format), and it
is stable.

## Where things live and who runs what

### Where the files go

- `summaries/` at the repository root, one file per extract or
  contract. It is derived, so it is not committed; CI regenerates it.
- `suss.json` at the root, written by `init`, committed. It says which
  packs and which documents this project reads, so every run compares
  the same things.
- `.sussignore.yml` at the root, committed. It is the list of findings
  the team decided to accept, each with a reason.

### Several services in one repository

Run one `extract` per service, each into its own file in the same
directory, and one `check --dir` over the directory. Pairing is by
boundary, so a handler in one file and a client in another compare
against each other whichever service produced them. At a monorepo root
`suss init` reads the workspace declaration and asks which packages to
set up, and writes one `suss.json` for the lot.

The team that owns a service owns its extract command, and the
pipeline runs all of them. There is no order to worry about; `check`
reads whatever is in the directory.

### Triaging a finding

A finding has a kind, a severity, a provider, a consumer and a
boundary. Read it as a claim about the two sides, and decide which of
three things it is:

- A bug in the code. Fix the code; the finding goes away on the next
  run.
- A document that fell behind. Fix the document.
- Something you accept. Add a rule to `.sussignore.yml` with a
  `reason`. The finding prints the rule to add, so this is a paste.

Errors are findings where the code on one side cannot work against
the other, such as reading a field the other side never sends.
Warnings are judgement calls, such as a status with no branch for it.
`check --json` writes the same findings for tooling to read, and
`--at` narrows a run to one boundary while you work through it.

### A suss miss or a bug

suss says when it could not read something, and that is the first
thing to check:

- A `Could not follow` line under a route in `inspect` output, or a
  `could not follow` sentence at the end of an `ask` answer, says a
  call landed somewhere suss could not read. Whatever is behind it is
  missing from the answer, and the answer says so.
- `confidence: low` on a summary or a finding says the same thing on
  the summary as a whole.
- `extract --explain` prints what each pack matched, file by file, so a
  service that came out thin shows where reading stopped.

A miss is an absence with one of those markers on it. A bug is a path
in the output that the code does not have, or an absence with no
marker, and the [issue tracker](https://github.com/nimbuscloud-ai/suss/issues)
is the place for it, with the `inspect` output for the route pasted in.
