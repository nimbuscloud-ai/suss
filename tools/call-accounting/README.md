# @suss/call-accounting

This package checks that every call the TypeScript adapter's invocation
walk visits inside a unit body ends up in one of three places: recorded
as an invocation effect, folded into a terminal, or in unreachable dead
code.

## Why

`extractRawBranches` walks a function body once, and puts each call it
finds either into a branch's effects or into a terminal's own shape.
Nothing checked that every call it visited was actually put somewhere.
Issues [#501](https://github.com/nimbuscloud-ai/suss/issues/501) and
[#531](https://github.com/nimbuscloud-ai/suss/issues/531) were each a
call that ended up in none of the three. The result was a well formed
summary with one fewer effect than the source has, and nothing in the
summary showed it.

## How it runs

`extractRawBranches` takes a flag, off by default, that makes it report
which of the three the branch pass above it already chose, for every
call it visited. This package reads that report over source that no
pack has looked at. It relies only on the terminals every function has
whatever the pack: a `return`, a `throw`, or falling off the end.

For each function-shaped root in a file, it runs the walk and checks
that no call comes back as neither recorded nor terminal while it comes
before a terminal that runs. A call in that state is what #501 and #531
each looked like before they were found.

## What it covers

`callAccounting.test.ts` runs the check over every TypeScript file
under `fixtures/`, and over every package this workspace ships. A
dropped call it does not already know about fails the suite with the
file, the line and the callee text.

`callAccounting.detectsDrops.test.ts` stubs the adapter's diagnostic to
report a dropped call, and checks that the check catches it. A healthy
corpus has no dropped calls, so there is nothing else to test the
failure path against.

## Scope

TypeScript only. Python and Ruby have their own walks, and neither has
an equivalent diagnostic yet.
