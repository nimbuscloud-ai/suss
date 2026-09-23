# Design records

These are proposals, roadmaps, decision logs and working notes, written
for the people building suss. Most of them argue for a change instead
of describing one, and some argue for a change nobody ever made.

`docs/` is different. It describes what suss does today, it is
published to the documentation site, and a reader can act on it.
Nothing in this directory is published, and nothing in it is a promise.
When a file here and the code disagree, trust the code.

## What is in here

- `proposals/` has one file per design proposal. Some shipped, some are
  still being argued over, and the code overtook some before anyone got
  to them. About half have a status line at the top. The rest don't say
  where they stand, so check the code before you act on one.
- `status.md` is the numbered decision log, oldest first, along with a
  phase-by-phase record of what got built.
- `backlog.md` lists work we have thought about and not started.
- The three `roadmap-*.md` files each plan one area: React, the second
  language adapter, and how deep the checker's comparisons go.
- The three `*-2026-07.md` files are one-off reviews from July 2026.
  One is about where the line falls between what ships as open source
  and what the company sells. One measures the project against its
  stated goals, and one critiques the documentation.
- The rest are notes on a single subject each: where a cold extract
  spends its time, where protocol knowledge lives, running the intent
  layer against suss's own surface, and the checks that tell you a pack
  has stopped working.

## Adding one

Write it here and not under `docs/`. Every markdown file under `docs/`
becomes a page on the site with its own URL, and it turns up in the
site search for anyone who types a word it happens to contain. A reader
who arrives that way cannot tell a proposal from a description of what
ships. So `docs/` is for what suss does, and this directory is for what
we argued about along the way.
