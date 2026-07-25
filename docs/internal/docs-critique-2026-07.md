# Docs critique, July 2026

Critique only. No doc changes made. Covers messaging, structure, and
wording, for the user-facing surfaces (README, site index, motivation,
the conceptual docs).

## Verdict

The messaging is mostly sound and the four-concept restructure improved
the prose docs. Two real problems remain:

1. **House style has not been applied.** The docs predate the no-dash,
   plain-wording conventions and violate them at scale (roughly 600 em
   dashes across the set, mixed British/American spelling, a few
   contrastive reframes). This is the largest and most mechanical gap.
2. **The landing page front matter was never reconciled with the
   restructure.** README prose got cut to the four-concept core, but
   `index.md`'s hero and six feature cards still carry the old framing,
   link into now-internal docs, and reintroduce the concepts the core
   tried to defer.

Two smaller issues: the tagline oversells in specific spots, and the
checker-vs-substrate positioning is inconsistent between surfaces.

## 1. Messaging

### The tagline

Current:

> Catch the drift between what your code says it does and what it does.
> suss derives every execution path, pairs the derivations across
> boundaries, and reports bugs that compile, type-check, and pass the
> tests.

Four specific problems:

- **"what your code says it does and what it does"** conflates two
  different things. Code does not "say" and "do" as separate acts. What
  *says* is the declared contract, the types, the caller's assumption;
  what *does* is the implementation across paths. The catchy phrasing
  blurs the actual gap suss finds, which is between a declaration or a
  caller's assumption and the derived behavior.
- **"derives every execution path"** overclaims. The rest of the docs
  are careful about opacity ("explicit about what it can't analyse",
  opaque predicates, confidence levels). "every" is the absolute those
  pages avoid, and a skeptical reader will catch the contradiction.
- **"derivations"** is internal vocabulary. A first-time visitor does
  not yet know what a derivation is; the word belongs in the glossary,
  not the hero.
- **"derives X, pairs Y, and reports Z"** is a three-verb escalating
  list, the rule-of-three pattern the house style flags. It also buries
  the strongest phrase ("bugs that compile, type-check, and pass the
  tests") at the end.

Direction, not final copy: lead with the bug class, which is the hook,
and drop the absolute. Something closer to "Find the bugs that compile,
type-check, and pass the tests: the ones where a caller and the code
quietly disagree about what a response means. suss reads what each
function actually does and compares it across the boundary."

### Hero text

"Behavioral correctness for TypeScript" uses "correctness", which
overclaims against suss's own stated scope. Motivation says plainly it
is "not a verifier" and "not a within-unit correctness tool"; it finds
divergence *between* units, not correctness *within* one. "Behavioral
agreement", "behavioral drift", or "behavioral analysis" all match the
product; "correctness" sets an expectation the tool declines elsewhere.

### Positioning: checker vs substrate

The landing page leads with checking ("catch the drift", the check
command, the drift feature card). But the differentiated claim, stated
in the README and in the positioning notes, is that the summary is the
product and checking is the most-developed use among several. Leading
with the checker frames suss as a linter competitor, which is the frame
the positioning explicitly wants to avoid. This is a strategic call, not
a wording fix: decide whether the front door sells the checker (concrete,
demoable, narrower) or the substrate (broader, harder to grasp in five
seconds), then make the hero, the feature order, and the tagline agree.
Right now the README leans substrate ("the summary is the product") and
the index hero leans checker, and they read as two different pitches.

## 2. Structure

The prose restructure landed, but `docs/index.md`'s front matter did
not move with it:

- **Feature cards link into the Internals tier.** "One model across
  every boundary" links to `/boundary-semantics`, which the restructure
  moved into the contributor-facing Internals sidebar group. The landing
  page sends new users straight at maintainer docs.
- **Stale link text.** The first feature card's link text is still "Why
  behavioral summaries", the title of a doc the restructure deleted and
  merged into motivation. The target resolves, the label lies.
- **The six cards reintroduce deferred concepts.** boundary-semantics,
  derivations, contract shapes, and packs all appear as first-screen
  vocabulary, which works against the four-concept core the restructure
  established. The card set predates the core and was not pruned to it.
- **README and sidebar disagree on tiers.** README groups
  "Contract sources" under "Understanding suss"; the sidebar puts
  contract-sources under Internals. Pick one home per doc and make both
  navigations agree.

The four-concept core holds up in the prose (README, motivation,
glossary). The weak point is the one surface a new visitor sees first.

## 3. Wording and house style

- **Em dashes, pervasive.** Roughly 600 across the user-facing docs
  (README 17, motivation 31, ir-reference 62, and so on). The adopted
  style bans em and en dashes everywhere. This is the highest-volume
  cleanup and is mechanical: replace with commas, periods, parentheses,
  or a rephrase.
- **Spelling drift.** "behavioural" appears 6 times against "behavioral"
  60 times; "analyse"/"analyze", "labelled"/"labeled" similarly mixed.
  index.md and faq.md carry most of the British forms. Pick American
  (the majority and the package naming) and sweep.
- **Contrastive reframes.** "suss compares behavioural derivations
  directly, not just the shapes around them" (index feature 1) and "a
  behavioral summary isn't a proof; it's a structured description"
  (motivation) are the "X, not Y" construction the style avoids. State
  the positive claim and stop.
- **Stale "stub" vocabulary.** contract-sources.md, ir-reference.md,
  behavioral-summary-format.md, and pipelines.md still say
  `confidence.source: "stub"` and "layered stub". The rename to
  "contract" shipped; these are wrong, not just off-style. pipelines.md
  also still narrates a two-phase manifest reader that is now split into
  @suss/manifest-aws.

## Recommended sequence

Four passes, cheapest and least contentious first:

1. **House-style sweep.** Dashes and spelling across all docs. Mechanical,
   high volume, no judgment calls. Biggest visible improvement per unit
   effort. A lint rule (a biome or remark check on `docs/**`) would keep
   it from regressing.
2. **Reconcile index.md with the core.** Fix the stale link text, retarget
   or drop the cards that point at Internals, prune the card set toward
   the four concepts, and align README and sidebar tiers.
3. **Fix stale facts.** The "stub" references and the pipelines.md
   manifest-reader narrative. These are correctness, not style.
4. **Tagline and positioning.** Tighten the tagline and settle the
   checker-vs-substrate lead. This one needs a product call before the
   wording can follow.

Passes 1 through 3 are clear wins and can proceed on sight. Pass 4 waits
on a positioning decision.
