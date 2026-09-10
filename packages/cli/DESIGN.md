# What the CLI reads before it extracts

How `suss init` reads a project's dependency manifests, and how a run treats a nested repository. Every command and every flag is in the [CLI reference](https://nimbuscloud-ai.github.io/suss/reference/cli).

## Reading a project's declared dependencies

`suss init` suggests packs based on the libraries a project declares. For `package.json` that is a single `JSON.parse`. Python and Ruby are harder, so each reader returns two things: the library names it managed to read, and the files or lines it could not read, along with why. If suss cannot read a manifest it cannot suggest packs for that project, and it needs to say so, because coming back with no suggestions looks exactly the same as finding nothing to suggest.

| Manifest | What it takes to read |
| --- | --- |
| `requirements.txt` / `.in` / `-dev` / `-test` | There is a whole grammar here: extras, version specifiers, environment markers, URL installs, `\` line continuations, and `-r` / `-c` includes that point at more files. The parser rejects the entire file if one line falls outside that grammar, so when a file will not parse as a whole we fall back to reading it line by line. A pip setting like `--index-url` does not declare a library and is not hiding one, so we skip it without comment; anything else we cannot parse gets reported. An editable install points at a directory, and that directory's own manifest is what declares the libraries, so there is no name to read off the line itself. |
| `pyproject.toml` | Three different spellings of the same list, depending on which tool wrote the file: the standard `project.dependencies`, plus Poetry's two tables. Dependencies marked dynamic get computed at build time, so we report them as unread. Poetry puts the Python interpreter itself in the same table as the libraries. |
| `setup.cfg` | Usually `install_requires` written out as requirement lines. setuptools also lets it point somewhere else, either at a file (`file: requirements.txt`) or at an attribute on the package (`attr: mypkg.__requires__`), and in that case the list is no more available to us than a computed one would be. |
| `setup.py` | This is a program, not data. If the file spells out a list literally, that is as good as a manifest; anything else only exists once Python has run. A single non-string element in the list means what we can see is not the whole list. |
| `Pipfile` | TOML. We read both the `packages` and `dev-packages` tables, each keyed by library name. |
| `Gemfile.lock` | A Gemfile is Ruby, and its gem list can come out of a loop or a call into another file, so we read the lock file that bundler writes instead. Only the `DEPENDENCIES` section counts. The `GEM` section below it lists everything those gems pulled in transitively, and suggesting a pack for a library the project never asked for would be a worse answer than suggesting none. If there is no lock file, we say so. |

We normalize Python names per PEP 503, so `Flask-RESTX`, `flask_restx`, and `flask.restx` count as one library instead of three.

## Nested repositories and submodules

When a service keeps its shared framework in a git submodule, it imports code that is on disk but belongs to a different repository. Both halves of a run have to deal with that. Extraction cares because the decorator a pack matches on is usually defined inside the submodule, so if an import into it does not resolve, every route in the service goes unrecognized. Discovery cares because a nested repository otherwise looks like somebody else's project, and walking into it looks like a mistake.

`.gitmodules` is what tells the two apart. The enclosing repository lists each submodule by path, so if a nested `.git` appears in that list it is part of this project and we add it as an extraction root. If it does not appear, it is a separate project that happens to sit inside the tree, and we drop its files from the walk. Extracting them would report another project's boundaries as though they were this one's.

A submodule nobody checked out is an empty directory. Imports into it resolve to nothing, and the summaries that depended on them quietly never get produced, so a run prints a warning on stderr, continues anyway, and records the problem in the incompleteness note it writes next to the summaries.
