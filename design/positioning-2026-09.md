# Positioning for code nobody has time to read

How suss is described to an engineer meeting it for the first time,
why the description changed in September 2026, and what that changes on
the README, the docs home page and the adoption guide.

## The problem the reader already has

Code arrives faster than anyone can read it. A team that ships with a
coding agent merges pull requests of a thousand lines several times a
day, and each one was written by something that will not be in the
room when it breaks. The review practices that team had before assumed
a reader could keep the whole diff in their head. They cannot any more,
and the two things they fall back on do not close the gap:

- Reading the diff tells you what the text changed, not what the
  service now does. A field dropped from one response object in a
  thousand-line pull request is one line among a thousand.
- Tests share the author's assumptions. When the author is the model
  that wrote the change, the tests it wrote check that the change does
  what the model meant, which is the one thing nobody doubts.

What the reviewer needs is a description of what the change does that
did not come from whoever wrote the change. suss produces that from the
code. It is deterministic and has no model in it, so it is a check on
the model rather than a second opinion from one.

That is the frame. The earlier description ("find the bugs that
compile, type-check and pass their tests") was true and stays true.
It did not say why now, and the audience it named (a team with a
handler and a client that drifted) was not the audience growing
fastest.

## What to say

The one-sentence description, for the repo, npm and anywhere else a
description field exists:

> Reads your code and checks what it does at every boundary, a route,
> a table or a queue, against the clients, specs and infrastructure on
> the other side. TypeScript, Python and Ruby.

The sentence says "boundary" rather than "endpoint" because a
summary is per unit, and a boundary is a table, a queue or an event
bus as often as a route. A reader with a Lambda and SQS service would
read "endpoint" and move on.

Taglines, for a hero, a post title or a talk slide. Use one at a time.

- Code is written faster than anyone can read it. suss tells you what
  it does.
- Review what the change does, not how much of it there is.
- The reader in your pipeline that is not a model.

The rules for anything longer than a tagline:

- Never write "post-AI", "AI era", "agentic" or similar on a page.
  State the volume problem and let the reader name the cause.
- Never imply that agents write worse code than people. The problem is
  volume and the absence of a second reader, and it applies to a
  large human-written change in the same way.
- Lead with `inspect --diff` on a pull request. That is the surface
  that meets the problem where the reader feels it. The MCP server is
  the same fact handed to the agent before the change is made, and it
  belongs beside the diff, not below the fold.
- State the limits on the same page as the claims. TypeScript is the
  furthest along; Python and Ruby read routes and fewer ORMs; a
  boundary is only checked inside one repository today.

## The demonstration

The claim needs one thing a reader can look at: a pull request of
around 1,500 lines written by an agent, the behavior diff suss posts on
it (a handful of lines), and the regression those lines catch. The
regression should be one a reviewer would miss in the text and a test
written by the author would not cover. A field dropped from one branch
of a response is the simplest. Every page and every post links to that
screenshot. Until it exists, the README shows the diff on a small
hand-written change, which makes the point on a smaller scale.

The GitHub Action that posts the diff is the surface to build for it.
It runs `extract` on the base and the head, runs `inspect --diff`, and
writes the result as a pull request comment. The Action is also the
thing a reader can adopt in ten minutes without changing anything else
about how they work, which is the adoption path this frame needs.

## The adoption ladder

An engineer should be able to get value from suss in an afternoon on
one service, with nothing to triage, and then decide whether to go
further. Each rung costs more and asks more of the codebase. The guide
under `docs/guides/adopting-suss.md` walks these in order.

1. Read one service. `extract` and `inspect` on a single service. The
   output is a tree of what each unit does on every path. There
   are no findings to triage. The engineer learns whether suss reads
   their stack, and where it says it could not follow something.
2. Question it. `suss ask` from the shell, or the MCP server from the
   agent. What writes this table, what does this route reach, what
   calls this function. Still no findings. This is the rung where a
   team that ships with agents gets the most, because the agent asks
   before it changes something.
3. Compare against a document you already keep. `suss contract` over
   an OpenAPI document, a Prisma schema or a deploy template, then
   `check`. The first findings appear. `suss init` is the shortcut
   that sets up this rung and the first.
4. Cross the boundary. Add the consumer side: a client pack, a
   frontend package, a queue consumer. Findings now say which caller
   breaks. This is where a `.sussignore` starts to matter.
5. Gate. `check --fail-on error` in CI, and `inspect --diff` on every
   pull request. The behavior diff is the thing a reviewer reads first.
6. Reuse the summaries. Hand them to agents as context, generate
   endpoint documentation from them, list the paths a test suite
   should cover.

The MCP rung comes before contracts on purpose. A single service with
no spec and no consumer can still be asked what it does, and a team
that adopted an agent last month has a use for that today.

## What changes on the pages

- README first screen: the description line, a tagline, the two
  commands (`extract` then `inspect`), the MCP config block beside
  them, then one `inspect --diff` rendering with a sentence saying
  what it caught. Below that, what you use it for (single-service
  moments first, then cross-boundary ones), then the ladder in six
  lines linking to the guide. The four-surface list, the pack table
  and the install notes move down to a reference section.
- Docs home page: the same frame in the hero and the feature cards.
  The first card is the pull request diff, the second is the MCP
  server, then who breaks, then spec drift.
- Adoption guide: the ladder above, one section per rung, each with
  the command, what it tells you, what it costs and what a false
  positive looks like at that rung. It also answers the workflow
  questions the current docs leave open: where summary files live,
  who runs `extract` in a repository with several services, how a
  finding gets triaged, and how to tell a suss miss from a bug in the
  code.

## Risks

- The frame reads as a claim about agents that suss cannot back.
  Mitigation: the demonstration, the limits paragraph, and never
  naming a vendor on the page.
- A reader tries rung one on a stack suss reads poorly and leaves.
  Mitigation: the README says which frameworks are covered in words,
  and the guide's first rung says what an empty or thin result means
  and how to tell whether it is the stack or the setup.
- Search traffic for "review AI generated code" expects a model-backed
  reviewer. Mitigation: the comparison and use-case pages say up front
  that suss is deterministic and what that buys, so the reader who
  wanted a model leaves quickly and the one who wanted a check stays.
