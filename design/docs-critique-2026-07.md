# Docs critique, July 2026

This is a critique only, and we made no doc changes with it. It looks
at the messaging, structure and wording of the user-facing surfaces:
the README, the site index, the motivation page and the conceptual
docs.

## Verdict

The messaging is mostly sound, and the four-concept restructure made
the prose docs better. Two problems remain:

1. **The house style has not been applied.** The docs are older than
   the conventions against dashes and for plain wording, and they break
   those conventions everywhere. There are roughly 600 em dashes across
   the set, British and American spellings are mixed, and there are a
   few contrastive reframes. This is the largest gap, and the most
   mechanical one to close.
2. **Nobody updated the landing page front matter after the
   restructure.** The README prose was cut down to the four-concept
   core, but the hero and the six feature cards in `index.md` still use
   the old framing. They link into docs that are now internal, and they
   bring back the concepts the core tried to put off.

There are two smaller issues. The tagline oversells in particular
places, and the surfaces are inconsistent about whether suss is a
checker or a substrate.

## 1. Messaging

### The tagline

Current:

> Catch the drift between what your code says it does and what it does.
> suss derives every execution path, pairs the derivations across
> boundaries, and reports bugs that compile, type-check, and pass the
> tests.

It has four problems:

- **"what your code says it does and what it does"** mixes up two
  different things. Code does not "say" and "do" as separate acts. What
  *says* is the declared contract, the types, or the caller's
  assumption. What *does* is the implementation across its paths. The
  catchy phrasing blurs the gap suss finds, which is between a
  declaration or a caller's assumption and the derived behavior.
- **"derives every execution path"** claims too much. The rest of the
  docs are careful about opacity ("explicit about what it can't
  analyse", opaque predicates, confidence levels). "every" is the
  absolute those pages avoid, and a skeptical reader will notice the
  contradiction.
- **"derivations"** is internal vocabulary. A first-time visitor does
  not know yet what a derivation is, so the word belongs in the
  glossary and not in the hero.
- **"derives X, pairs Y, and reports Z"** is a list of three verbs that
  builds up, the rule-of-three pattern the house style flags. It also
  hides the strongest phrase ("bugs that compile, type-check, and pass
  the tests") at the end.

A direction, not final copy: lead with the kind of bug, since that is
what hooks the reader, and drop the absolute. Something closer to "Find
the bugs that compile, type-check, and pass the tests: the ones where a
caller and the code quietly disagree about what a response means. suss
reads what each function actually does and compares it across the
boundary."

### Hero text

"Behavioral correctness for TypeScript" uses "correctness", which
claims more than suss's own stated scope. The motivation page says
plainly that suss is "not a verifier" and "not a within-unit
correctness tool". It finds divergence *between* units and does not
check correctness *within* one. "Behavioral agreement", "behavioral
drift" and "behavioral analysis" all describe the product. "Correctness"
sets an expectation that the docs turn down elsewhere.

### Positioning: checker vs substrate

The landing page leads with checking: "catch the drift", the check
command, the drift feature card. But the claim that sets suss apart,
stated in the README and in the positioning notes, is that the summary
is the product and checking is the most developed of several uses.
Leading with the checker makes suss look like a competitor to linters,
and the positioning explicitly wants to avoid that. Wording alone won't
fix this, because it is a strategic decision. Decide whether the front
door sells the checker (concrete, easy to demo, narrower) or the
substrate (broader, harder to grasp in five seconds). Then make the
hero, the order of the features and the tagline agree. Today the README
leans toward the substrate ("the summary is the product") and the index
hero leans toward the checker, and they read as two different pitches.

## 2. Structure

The prose restructure landed, but the front matter of `docs/index.md`
did not change with it:

- **Feature cards link into the Internals tier.** "One model across
  every boundary" links to `/boundary-semantics`, which the restructure
  moved into the Internals sidebar group for contributors. So the
  landing page sends new users straight to docs meant for maintainers.
- **Stale link text.** The first feature card's link text is still "Why
  behavioral summaries". That was the title of a doc the restructure
  deleted and merged into the motivation page. The link still resolves,
  but its label is wrong.
- **The six cards bring back concepts the core put off.**
  boundary-semantics, derivations, contract shapes and packs all appear
  as vocabulary on the first screen, which works against the
  four-concept core the restructure set up. The cards are older than
  the core, and nobody cut them down to match.
- **README and sidebar disagree on tiers.** The README puts "Contract
  sources" under "Understanding suss", and the sidebar puts
  contract-sources under Internals. Pick one home for each doc and make
  both navigations agree.

The four-concept core works in the prose (README, motivation,
glossary). The weak point is the surface a new visitor sees first.

## 3. Wording and house style

- **Em dashes everywhere.** There are roughly 600 across the
  user-facing docs (README 17, motivation 31, ir-reference 62, and so
  on). The adopted style bans em and en dashes everywhere. This is the
  largest fix by volume, and it is mechanical: replace each one with a
  comma, a period or parentheses, or rephrase.
- **Spelling drift.** "behavioural" appears 6 times and "behavioral" 60
  times, and "analyse"/"analyze" and "labelled"/"labeled" are mixed the
  same way. Most of the British forms are in index.md and faq.md. Pick
  American, since it is the majority and the packages use it, and fix
  every page.
- **Contrastive reframes.** "suss compares behavioural derivations
  directly, not just the shapes around them" (index feature 1) and "a
  behavioral summary isn't a proof; it's a structured description"
  (motivation) are the "X, not Y" construction the style avoids. State
  the positive claim and stop.
- **Stale "stub" vocabulary.** contract-sources.md, ir-reference.md,
  behavioral-summary-format.md and pipelines.md still say
  `confidence.source: "stub"` and "layered stub". The rename to
  "contract" shipped, so these are factually wrong and not only off
  style. pipelines.md also still describes a two-phase manifest reader
  that has since been split out into @suss/manifest-aws.

## Recommended sequence

Four passes, with the cheapest and least contested first:

1. **House-style sweep.** Fix dashes and spelling across all docs. It
   is mechanical and high volume, needs no judgment calls, and gives
   the biggest visible improvement for the effort. A lint rule (a biome
   or remark check on `docs/**`) would stop it from coming back.
2. **Reconcile index.md with the core.** Fix the stale link text, point
   the cards that go to Internals somewhere else or drop them, cut the
   card set down toward the four concepts, and make the README and
   sidebar tiers agree.
3. **Fix stale facts.** These are the "stub" references and the
   description of the manifest reader in pipelines.md. They are wrong
   facts, where the others are matters of style.
4. **Tagline and positioning.** Tighten the tagline and decide whether
   to lead with the checker or the substrate. This one needs a product
   decision before the wording can follow.

Passes 1 to 3 are clear improvements and can go ahead right away. Pass
4 waits on a positioning decision.
