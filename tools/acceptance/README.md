# @suss/acceptance

This package runs the built `suss` binary over the repository's fixture
projects and asserts on what a person gets back: the exit code, the
summaries, and the sentence it printed.

## Why it is separate from the CLI's own tests

Every test under `packages/cli` imports a TypeScript source file. That
layer is one below the seam, and a test there keeps passing while the
seam misbehaves. Two bugs shipped that way:

- `inspectProject` had a test, but the code that printed its result
  threw away the languages it found, so a person with a Python project
  was told that nothing matched and never told that suss had seen the
  Python.
- `resolveSource` walked up the tree looking for a config file, and the
  function that decided the language did not, so the two gave different
  answers for the same directory.

Neither is visible from a test that calls the function. Both are
visible from a test that runs the command.

The package lives under `tools/` rather than `packages/` because the
publish and coverage gates walk `packages/`, and nothing here ships.
It reports no coverage: it imports no source file, and a subprocess
records none for its parent. What it covers is the binary.

## Running it

```bash
npm run test -w @suss/acceptance
```

`turbo test` runs it alongside everything else, and `test` depends on
`build`, so the binary is there. The whole set takes a few seconds, so
it runs on every pull request rather than nightly.

## Writing a journey

One test is one thing a person does, end to end. Point suss at a
project, read the output, and assert on the part they would have looked
at: the route is there, the two sides paired, the sentence tells them
what to type instead.

Assert the specific thing rather than a whole snapshot. A snapshot that
changes on every run teaches people to accept it without reading, which
is how the output regressions above got through review.

A journey that fails is the point of the package, so leave it failing
rather than loosening it until it passes. Fix the product where the fix
is proportionate. Where it is not, `it.fails` records the gap: the test
passes while the gap is open, and it goes red the day the gap closes,
which is your reminder to promote it back to `it`.

Reach for `it.fails` sparingly, and only once you have established that
the fix is out of reach. The line numbers that Python and Ruby reported
were marked that way on an architectural argument that turned out to be
half right, and a two-line change fixed them.
