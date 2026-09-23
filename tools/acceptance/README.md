# @suss/acceptance

This package runs the built `suss` binary over the repository's fixture
projects, and checks what a person gets back: the exit code, the
summaries, and the sentence it printed.

## Why it is separate from the CLI's own tests

Every test under `packages/cli` imports a TypeScript source file. That
is one layer below the command a person runs, and a test there keeps
passing when the command itself misbehaves. Two bugs shipped that way:

- `inspectProject` had a test, but the code that printed its result
  threw away the languages it found. So a person with a Python project
  was told that nothing matched, and was never told that suss had seen
  the Python.
- `resolveSource` walked up the tree looking for a config file, and the
  function that decided the language did not, so the two gave different
  answers for the same directory.

A test that calls the function cannot see either bug. A test that runs
the command sees both.

The package lives under `tools/` and not `packages/`, because the
publish and coverage gates walk `packages/`, and nothing here ships. It
does not report coverage, because it does not import any source file,
and a subprocess does not record coverage for its parent. What it covers is the binary.

## Running it

```bash
npm run test -w @suss/acceptance
```

`turbo test` runs it with everything else, and `test` depends on
`build`, so the binary is there. The whole set takes a few seconds, so
it runs on every pull request instead of nightly.

## Writing a journey

One test is one thing a person does, from start to finish. Point suss
at a project, read the output, and check the part the person would have
looked at: the route is there, the two sides paired, or the sentence
tells them what to type instead.

Check the specific thing, and do not snapshot the whole output. A
snapshot that changes on every run teaches people to accept it without
reading it, which is how the output regressions above got through
review.

A failing journey is the reason this package exists, so leave it
failing. Do not loosen it until it passes. Fix the product when the fix
is in proportion to the problem. When it is not, `it.fails` records the
gap. The test passes while the gap is open, and goes red the day the
gap closes, which reminds you to change it back to `it`.

Use `it.fails` rarely, and only once you have shown that the fix is out
of reach. The line numbers that Python and Ruby reported were once
marked that way, on an architectural argument that turned out to be
half right, and a two-line change fixed them.
