# constructs/

This module works out the answer to `suss ask "how is <unit> used"`. A construct is a
helper the team wrote that many routes and jobs go through: an HTTP
client, a key-value store, a filter that can send the response itself.
`constructUsage` takes the summaries, the call facts, and either the
construct's units or the touches of a boundary, and gives back the
calls, grouped, with the callers and the entry points that reach them.
The CLI prints it, and the map and MCP can read the same structure.

## One construct, several summaries

A pack and reach can each write a summary of one function. The net-http
pack writes a `client` for the method that sends the request, with one
path per way it ends, and reach writes a `library` summary of the same
method with one path. Both cover the same lines, so the construct is
every summary over them. The calls into it are the calls into either
one. The ways it can fail come from the pack's summary, since the
summary reach built has one path and does not record a throw.

A method of the same class that calls the subject and serves no
boundary of its own is part of the construct too, as `fetch_quietly` is for
`fetch`. A caller outside the class goes through it, so the answer
counts those calls under it.

## Grouping calls

A call is grouped by what it passes for the parameters that reach the
boundary. Two facts say which those are. `selects(f, p)` says `f` uses
parameter `p` for a column it selects rows by, for a container
written as a reference such as `{location.table}`, or for a client's
method or host, or tests it to pick which request to make, as a
client's `bindingFrom` records. `forwards(f, p, g, q)` says `f` passes
its own `p` to `g` as `g`'s `q`. The `counted` rule closes over both, so
`enabled?(key)` counts `key` because the method it calls, `lookup(key)`,
selects rows by it. `keyed` and `leftOut` then join each call to the
counted parameters of the function it calls. A call that leaves a
counted parameter out is keyed by the parameter's default when the
source writes the default as a literal, so `fetch(url)` and
`fetch(url, :get)` share a group when `method` defaults to `:get`.
Every other parameter plays no part, since grouping on every argument
would give one group per call.

Each value prints as the source writes it. A part computed at run time
is blanked to `_`, and two calls share a group when their blanked values
are equal, so `"user:#{id}:theme"` and `"user:#{user.id}:theme"` are one
group.

A call fills a parameter by the keyword argument written with its name,
in Python and Ruby, and otherwise by place. A splat, `*args`, fills every
parameter from its place on with a value suss cannot read.

## Which request a call makes

A helper that picks its request with an `if` on a parameter has one
client unit per request, each over the helper's lines, and each records
under `bindingFrom.when` the tests on its inputs that every path to its
request passes. Each test that compares a parameter with a literal is a
`requires` fact, or an `excludes` fact under a negation. A call makes
the request when every test is true of what it passes, and the `sends`
rule says so. A test that fails rules the request out. When a test
compares with something other than a literal, or the call passes a
value that is not a literal, the test is open, and `maySend` says the
call could make that request. When a helper has several requests and
the summaries do not record a test on one of them, the helper picks it
by something they do not read, so every call could make it.

A client that hands the method to the library sends what the call
passes for that parameter, or the default, upper-cased.

## Reach

The entry points that reach a caller come from `CallFacts.reaching`,
the same reach `what reaches` uses, one question per caller. A path
through a call that picks its function at run time is possible, and an
entry point is listed as possible only when no certain path reaches it.

## What is left out

- A host read out of a URL groups the calls by the URL, with its
  computed parts blanked, and not by the host alone.
- A Ruby `case` or a Python `match` on the parameter. The path lowering
  does not give an arm the test on its subject yet, so the clients do
  not record a test and every call could make any of their requests.
- A request made by a helper the call reaches through another function.
  Only the client units over the function the call goes into count.
- Which `rescue`, `except` or `catch` covers a call. The answer says how
  the construct fails, and does not say which callers handle it.
- Calls from functions that no entry point reaches and that have no
  summary. A caller with a summary that nothing reaches is listed as a
  gap. A call suss did not follow that uses the name of one of the
  construct's methods is listed too, with the entry points that reach
  the unit making it.
