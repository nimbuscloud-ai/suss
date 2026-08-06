---
name: Bug report
about: Report something that isn't working as expected
title: ""
labels: bug
assignees: ""
---

<!--
Title the issue with the symptom in plain words: what a reader or a
run sees go wrong, not the internal mechanism. "A hand-typed
suppression rule for a message-bus boundary never matches" reads in
a list; "fix normalizeRuleBoundary" does not.
-->

## What happened

<!-- A concise description of the bug. -->

## What you expected

<!-- What you expected to happen instead. -->

## Minimal reproduction

<!--
The smallest TS source + tsconfig + suss command that reproduces the issue.
A handful of files inline is usually enough — please paste the actual code,
not a description of it.
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

<!-- Anything else that might help — related issues, recent changes, etc. -->
