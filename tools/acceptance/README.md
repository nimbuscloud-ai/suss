# @suss/acceptance

Runs the built `suss` binary over the repository's fixture projects and
asserts on what a person gets back: the exit code, the summaries, the
sentence printed.

## Why it is separate from the CLI's own tests

Every test under `packages/cli` imports a TypeScript source file. That
layer is one below the seam, and a test there keeps passing while the
seam misbehaves. Two shipped that way:

- `inspectProject` was tested, and the code printing its result threw
  away the languages it found, so a person with a Python project was
  told nothing matched and never told suss had seen the Python.
- `resolveSource` walked up for a config file, and the function
  deciding the language did not, so the two answered differently about
  the same directory.

Neither is visible from a test that calls the function. Both are
visible from a test that runs the command.

The package sits under `tools/` rather than `packages/` because the
publish and coverage gates walk `packages/`, and nothing here ships.
It runs no coverage: it imports no source file, and a subprocess
records none for its parent. What it covers is the binary.

## Running it

```bash
npm run test -w @suss/acceptance
```

`turbo test` runs it alongside everything else, and `test` depends on
`build`, so the binary is there. The whole set is a few seconds, so it
runs on every pull request rather than nightly.

## Writing a journey

One test reads as one thing a person does, end to end. Point suss at a
project, read the output, assert on the part they would have looked
at: the route is there, the two sides paired, the sentence says what to
type instead.

Assert the specific thing rather than a whole snapshot. A snapshot that
changes on every run teaches people to accept it without reading, which
is how the output regressions above got through review.

A journey that fails is the point of the package, so it stays failing
rather than being loosened to pass. Fix the product where the fix is
proportionate. Where it is not, `it.fails` records the gap: the test
passes while the gap is open and goes red the day it closes, which is
the reminder to promote it back to `it`.

Reach for `it.fails` sparingly, and only after establishing that the
fix is genuinely out of reach. The line numbers Python and Ruby
reported were marked that way on an architectural argument that turned
out to be half right, and a two-line change fixed them.
