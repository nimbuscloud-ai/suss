# @suss/call-accounting

Asserts that every call the TypeScript adapter's invocation walk visits
inside a unit body lands in one of three places: recorded as an
invocation effect, folded into a terminal, or unreachable dead code.

## Why

`extractRawBranches` walks a function body once and sorts each call it
finds into a branch's effects or into a terminal's own shape. Nothing
checked that every call it visited actually landed somewhere. Issue
[#501](https://github.com/nimbuscloud-ai/suss/issues/501) and
[#531](https://github.com/nimbuscloud-ai/suss/issues/531) were each a
call that reached none of the three: a well formed summary with one
fewer effect than the source has, and nothing about the summary said so.

## How it runs

`extractRawBranches` takes an opt-in flag that makes it report, for
every call it visited, which of the three the branch pass above it
already decided on. This package reads that report back over source no
pack has looked at, using the terminal shapes every function has
regardless of pack: a `return`, a `throw`, or falling off the end.

For each function-shaped root in a file, it runs the walk and checks
that no call comes back neither recorded nor terminal while sitting
before a terminal that runs. A call in that state is what #501 and #531
each looked like before they were found.

## What it covers

`callAccounting.test.ts` runs the check over every TypeScript file
under `fixtures/` and over every package this workspace ships. A
dropped call it does not already know about fails the suite with the
file, the line and the callee text.

`callAccounting.detectsDrops.test.ts` stubs the adapter's diagnostic to
report a dropped call and asserts the check catches it, since a healthy
corpus has none to exercise the failure path against directly.

## Scope

TypeScript only. Python and Ruby have their own walks with no
equivalent diagnostic yet.
