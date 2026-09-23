# What the CLI reads before it extracts

This document describes how `suss init` reads a project's dependency manifests, and how a run treats a nested repository. Every command and every flag is in the [CLI reference](https://suss.sh/reference/cli/).

## Reading a project's declared dependencies

`suss init` suggests packs based on the libraries a project declares. For `package.json` that takes a single `JSON.parse`. Python and Ruby are harder, so each reader returns two things: the library names it managed to read, and the files or lines it could not read, with the reason. If suss cannot read a manifest, it cannot suggest packs for that project, and it has to report that. Otherwise the user sees no suggestions and cannot tell that apart from a project with nothing to suggest.

| Manifest | What it takes to read |
| --- | --- |
| `requirements.txt` / `.in` / `-dev` / `-test` | These files have a whole grammar: extras, version specifiers, environment markers, URL installs, `\` line continuations, and `-r` / `-c` includes that point at more files. The parser rejects the entire file if one line falls outside that grammar, so when a file does not parse as a whole, the reader falls back to reading it line by line. A pip setting like `--index-url` neither declares a library nor hides one, so the reader skips it without comment. Anything else it cannot parse gets reported. An editable install points at a directory, and that directory's own manifest declares the libraries, so the line itself has no name to read. |
| `pyproject.toml` | The same list can be spelled three ways, depending on which tool wrote the file: the standard `project.dependencies`, plus Poetry's two tables. Dependencies marked dynamic are computed at build time, so the reader reports them as unread. Poetry puts the Python interpreter itself in the same table as the libraries. |
| `setup.cfg` | Usually `install_requires` written out as requirement lines. setuptools also lets it point somewhere else, either at a file (`file: requirements.txt`) or at an attribute on the package (`attr: mypkg.__requires__`). In that case the reader can no more see the list than it could see a computed one. |
| `setup.py` | This file is a program. If it writes a list out literally, the reader can use it the same as a manifest. Anything else only exists once Python has run. A single non-string element in the list means the part the reader can see is not the whole list. |
| `Pipfile` | TOML. The reader reads both the `packages` and `dev-packages` tables, each keyed by library name. |
| `Gemfile.lock` | A Gemfile is Ruby, and its gem list can come out of a loop or a call into another file, so the reader reads the lock file that bundler writes instead. Only the `DEPENDENCIES` section counts. The `GEM` section below it lists everything those gems pulled in transitively, and suggesting a pack for a library the project never asked for would be worse than suggesting none. If there is no lock file, the reader reports that. |

Python names are normalized per PEP 503, so `Flask-RESTX`, `flask_restx`, and `flask.restx` count as one library.

## Nested repositories and submodules

When a service keeps its shared framework in a git submodule, it imports code that is on disk but belongs to a different repository. Both halves of a run have to handle that. Extraction needs the submodule, because the decorator a pack matches on is usually defined inside it. If an import into the submodule does not resolve, every route in the service goes unrecognized. Discovery has the opposite problem: a nested repository otherwise looks like somebody else's project, and walking into it looks like a mistake.

`.gitmodules` tells the two cases apart. The enclosing repository lists each submodule by path. If a nested `.git` appears in that list, it is part of this project, and suss adds it as an extraction root. If it does not appear, it is a separate project that happens to be inside the tree, and suss drops its files from the walk. Extracting them would report another project's boundaries as if they were this one's.

A submodule nobody checked out is an empty directory. Imports into it resolve to nothing, and the summaries that depended on them are silently never produced. So a run prints a warning on stderr, continues, and records the problem in the incompleteness note it writes next to the summaries.

## Corroboration verdicts

`suss corroborate` is experimental. It runs each handler in a vm with inputs that satisfy a transition's extracted conditions, and writes one of three verdicts on the transition:

- `observed`: every run that satisfied the conditions sent the status the summary claims.
- `refuted`: at least one such run sent a different status. The verdict includes that input as a counterexample. The cause may be a bug in extraction or behavior in the handler that nobody expected, and the user needs to hear about either one.
- `untested`: no run reached a verdict. Either sampling never found an input the conditions accepted, or every run failed. A run that fails with a bare `ReferenceError` has reached a dependency the sandbox cannot supply, and the reason says the path is dependency-gated.

The inputs come from rejection sampling, with no constraint solver. The sampler builds candidates from the input paths and string literals in the conditions, and the three-valued condition evaluator decides whether each one satisfies them.
