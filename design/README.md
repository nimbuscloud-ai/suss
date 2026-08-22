# Design records

Proposals, roadmaps, decision logs and working notes, written for
whoever is building suss. Most of them argue for a change rather than
describe one, and some argue for a change nobody ever made.

`docs/` is the other thing. It describes what suss does today, it gets
published to the documentation site, and a reader can act on it. Nothing
in this directory is published and nothing in it is a promise. Where a
file here and the code disagree, the code is right.

## What is in here

- `proposals/` has one file per design proposal. Some shipped, some are
  still being argued over, and some were overtaken by the code before
  anyone got to them. About half carry a status line at the top; the
  rest say nothing about where they stand, so check the code before you
  act on one.
- `status.md` is the numbered decision log, oldest first, alongside a
  phase-by-phase record of what got built.
- `backlog.md` lists work we have thought about and not started.
- The three `roadmap-*.md` files plan one area each: React, the second
  language adapter, and how deep the checker's comparisons go.
- The three `*-2026-07.md` files are one-off reviews from July 2026.
  They cover where the line falls between what ships open and what the
  company sells, the project measured against its stated goals, and a
  critique of the documentation.
- The rest are notes on a single subject: where a cold extract spends
  its time, where protocol knowledge lives, running the intent layer
  against suss's own surface, and the checks that say a pack has stopped
  working.

## Adding one

Write it here rather than under `docs/`. Every markdown file under
`docs/` becomes a page on the site with its own URL, and it turns up in
the site search for anyone who types a word it happens to contain. A
reader who arrives that way cannot tell a proposal from a description of
what ships. So `docs/` is for what suss does, and this directory is for
what we argued about along the way.
