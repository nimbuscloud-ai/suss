---
name: Bug report
about: Report something that isn't working as expected
title: ""
labels: bug
assignees: ""
---

<!--
Title the issue with the symptom in plain words: what a reader or a
run sees go wrong. Leave the internal mechanism for the body. "A
hand-typed suppression rule for a message-bus boundary never matches"
is clear in a list of issues; "fix normalizeRuleBoundary" is not.
-->

## What happened

<!-- A short description of the bug. -->

## What you expected

<!-- What you expected to happen instead. -->

## Minimal reproduction

<!--
The smallest TS source, tsconfig and suss command that reproduce the
issue. A handful of files inline is usually enough. Please paste the
code itself, since a description of it is much harder to reproduce.
-->

```ts
// handler.ts

```

```sh
suss extract -p tsconfig.json -f express
```

## Output

<!-- The full output you got (extracted summary, finding, error message, stack trace). -->

```
```

## Environment

- suss version:
- Node version:
- OS:
- Framework / pack(s) involved:

## Additional context

<!-- Anything else that might help, such as related issues or recent changes. -->
