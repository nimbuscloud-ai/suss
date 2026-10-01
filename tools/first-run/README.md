# @suss/first-run

This package runs a published suss release over public repositories the way a newcomer would, and records what each first run produced. The question behind it is how often does a first run on somebody else's code tell them something true and useful?

`repos.json` lists the repositories. Each one keeps a server and the client that calls it in one repository, and each is pinned to a full commit so a rerun reads the same code.

## Running it

Install the release under test into its own prefix, so a global link or the workspace build cannot stand in for it:

```bash
npm install --prefix /tmp/suss-cli @suss/cli@0.34.0
npx tsx tools/first-run/src/run.ts --work /tmp/first-run --cli /tmp/suss-cli/node_modules/.bin/suss
npx tsx tools/first-run/src/table.ts --work /tmp/first-run
```

`--only immich,lobsters` runs a subset. `--skip-install` leaves dependencies out, which costs the TypeScript packs their type information, so results from it are a lower bound. `--bun` and `--yarn` point at those package managers when they are not on the path. `--budget-minutes` changes the 30 minutes each repository gets, install included.

Repositories run one at a time, and every command runs under `timeout 900`.

## What it does for each repository

1. Fetches the pinned commit and its parent into `<work>/repos/<name>` with depth 2. A second run reuses the clone and its `node_modules`, and removes everything else an earlier run wrote.
2. Installs dependencies with the manager the lockfile says, with lifecycle scripts off. A root lockfile covers the workspace; without one it installs each client folder that has its own.
3. Runs `suss init --write` at the root.
4. Runs every `suss` command init printed except `check`. A command whose paths start from the root, with `--dir` on an extract or the project's folder at the start of a contract's path, runs at the root. Releases up to 0.34.0 printed paths relative to each project, so their commands run in the project folder given in the section heading. When init prints a pack config for the user to write, it writes the example init printed, the way a newcomer following the instructions would. All outputs go to one folder, so one `check` sees both sides.
5. Runs `suss check --dir` over that folder twice, once with `--json` for the counts and once for the text a person reads.
6. Checks out the parent commit, re-runs the extract commands, and runs `suss inspect --diff` between the two, the way the pull request comment does.

## What it writes

`<work>/results/<name>/` has:

- `result.json`: exit code, wall time and peak memory for every step, summary counts per file, the check counts, the diff counts, init's notes, pack health lines and errors.
- One log per step with the command line, its stdout and its stderr.
- `check.json`, `check.txt`, `diff.json` and `diff.txt`, the CLI's own output.

Peak memory is the largest single process the system `time` saw, so it misses a worker that stayed smaller than the CLI.

`table.ts` turns the results into Markdown rows. Grading a run means reading its findings against the code, so grades are written by hand.
