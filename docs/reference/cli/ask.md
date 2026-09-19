---
title: suss ask
description: Ten questions you can ask about a codebase from summaries on disk, the flags each one takes, and the JSON it writes.
---

# `suss ask`

Ask one question about one boundary, without writing a call first.

**What it does.** It reads summaries off disk and answers from them. An
index with a narrow projection is a set of attributes fixed in terraform
and invisible to TypeScript; autocomplete is the right answer to that and
there is nowhere to put it, so the next best thing is being able to ask.

```
suss ask "QUESTION" [--dir DIR | SUMMARIES.json] [--project DIR] [--json] [-o OUTPUT]
```

Ten questions, in these words:

| Question | What comes back |
|---|---|
| `what can I project from <boundary>` | What the boundary declares: the fields a store serves, the statuses a contract declares, the env vars a runtime takes. Also written `what does <boundary> declare`. |
| `what reads <boundary>` | Every unit that reads it, with the file, the line, and the call. |
| `what writes <boundary>` | The same, for writes. |
| `what invokes <boundary>` | Every unit that calls a deployed unit by name, such as one Lambda invoking another. |
| `what calls <unit>` | Every unit whose calls the run resolved to it, with the file, the line, and the call. The unit is spelled the way `--at` spells one: a file, a `file:line`, a summary id, or a function name. A package export such as `fn:@suss/datalog::evaluate` is the function behind it, so that spelling, the bare name, and `what reads` on the export give one answer. A bare name that is two functions in different places is refused, with both listed. |
| `what does <unit> reach` | Every boundary a file or a summary goes through, and whether it reads, writes or invokes each. |
| `what reaches <target>` | Every boundary whose unit ends up going through the target, and the calls it took to get there. The same call facts as `what calls`, closed over every hop with no limit on the chain, which is what somebody changing a store or a function wants before they change it. A unit is listed only when it serves a boundary of its own, so the answer is routes, queues, and package exports rather than the functions between them. The answer says how many calls resolved to no unit, since a boundary reaching the target through one of those is missing from it. |
| `what does <package or unit> provide` | Every boundary it provides, one per line, sorted by boundary key. A package is spelled by its name, `@suss/checker`, and the answer gathers its exports wherever they sit in the run. Also written `what does <package> export`. |
| `why does <unit> reach <target>` | The shortest call chain from the unit to a boundary, a function, or a package export, with each written hop's resolution proved from source. The same call facts as `what reaches`, so the chain is the one that answer lists under the unit. Both ends are spelled the way `what calls` takes a unit, and a bare name that is two functions is refused. |
| `why does <name> at <file>:<line> resolve to <target>` | The chain from a written name to the function it comes down to, one reason per hop. |

The boundary is spelled the way reports spell it, and a shorter spelling
covers more, exactly as under [`--at`](/reference/cli/check#reporting-on-one-thing). A
service call counts as both a read and a write, since a request sends a
body out and gets a response back. Calling a deployed unit by name does
the same two things and is reported as `invokes`, because a service made
of Lambdas would otherwise read as every function reading and writing
every other one. When a spelling covers several
boundaries at once, suss says which ones rather than picking one, and a
spelling that is exactly one boundary's name takes that one:
`GET /articles` is the collection route, not the comments route under
it.

When the unit an item is about provides a boundary itself, an exported
function or a route, the item says which one after the location:
`discoverUnits (src/discovery.ts:150, provides
fn:@suss/adapter-python::discoverUnits) calls builtSubjects`. The JSON
form has the same key in a `provides` field. Read that rather than the
summary id, which only spells the boundary when two summaries share a
name.

An answer also says when a unit suss could not read all of could be
missing from it. `--json` gives the same answer as `{ question, shape,
subject, found, headline, items, needs, caveats }`, and a why answer
adds the chain, the hops with their resolution steps, and what the
re-evaluation cost.

[Ask about a codebase](/guides/ask) walks through what each answer looks
like, including the symbol shorthand. [Exit codes](/reference/cli/exit-codes#suss-ask)
says what `ask` returns to the shell.

