# Positioning for code nobody has time to read

This is how we describe suss to an engineer who is meeting it for the
first time, why the description changed in September 2026, and what
the change means for the README, the docs home page and the adoption
guide.

## The problem the reader already has

Code arrives faster than anyone can read it. A team that ships with a
coding agent merges pull requests of a thousand lines several times a
day, and each one was written by something that will not be in the
room when it breaks. The team's review practices assumed a reader could
keep the whole diff in their head. Nobody can any more, and neither of
the two things reviewers fall back on closes the gap:

- Reading the diff tells you how the text changed. It does not tell
  you what the service now does. A field dropped from one response
  object in a thousand-line pull request is one line among a thousand.
- Tests share the author's assumptions. When the author is the model
  that wrote the change, its tests check that the change does what the
  model meant, and nobody doubts that part.

The reviewer needs a description of what the change does that did not
come from whoever wrote it. suss produces that description from the
code. It is deterministic and has no model in it, so it checks the
model's work instead of offering a second model's opinion.

The earlier description ("find the bugs that compile, type-check and
pass their tests") was true and is still true. But it did not say why
this matters now, and the audience it described (a team with a handler
and a client that drifted apart) was not the audience growing fastest.

## What to say

The one-sentence description, for the repo, npm and anywhere else that
has a description field:

> Reads your code and checks what it does at every boundary, a route,
> a table or a queue, against the clients, specs and infrastructure on
> the other side. TypeScript, Python and Ruby.

The sentence says "boundary" and avoids "endpoint". A summary describes
one unit, and that unit's boundary is a table, a queue or an event bus
as often as a route. A reader with a Lambda and SQS service would read
"endpoint" and move on.

Taglines, for a hero, a post title or a talk slide. Use one at a time.

- Code is written faster than anyone can read it. suss tells you what
  it does.
- Review what the change does, not how much of it there is.
- The reader in your pipeline that is not a model.

Rules for anything longer than a tagline:

- Never write "post-AI", "AI era", "agentic" or similar on a page.
  Describe the volume problem and let the reader supply the cause.
- Never imply that agents write worse code than people. The problem is
  volume and the lack of a second reader, and a large change written by
  a person has the same problem.
- Lead with `inspect --diff` on a pull request. That is where the
  reader feels the problem, and it is where suss meets it. The MCP
  server gives the agent the same information before it makes the
  change. Put it next to the diff, near the top of the page.
- State the limits on the same page as the claims. TypeScript is the
  furthest along. Python and Ruby read routes and fewer ORMs. Today a
  boundary is only checked inside one repository.

## The demonstration

The claim needs one thing a reader can look at. That is a pull request
of around 1,500 lines written by an agent, the behavior diff suss posts
on it (a handful of lines), and the regression those lines catch. Pick
a regression a reviewer would miss in the text and a test written by
the author would not cover. The simplest is a field dropped from one
branch of a response. Every page and every post links to that
screenshot. Until it exists, the README shows the diff on a small
hand-written change, which makes the same point at a smaller scale.

To support it, build the GitHub Action that posts the diff. It runs
`extract` on the base and the head, runs `inspect --diff`, and writes
the result as a pull request comment. A reader can also adopt the
Action in ten minutes without changing anything else about how they
work, and this positioning needs that kind of adoption path.

## The adoption ladder

An engineer should be able to get value from suss in an afternoon on
one service, with nothing to triage, and then decide whether to go
further. Each rung costs more and asks more of the codebase. The guide
under `docs/guides/adopting-suss.md` walks through them in order.

1. Read one service. Run `extract` and `inspect` on a single service.
   The output is a tree of what each unit does on every path, and
   there are no findings to triage. The engineer learns whether suss
   reads their stack, and where it reports that it could not follow
   something.
2. Question it. Use `suss ask` from the shell, or the MCP server from
   the agent: what writes this table, what does this route reach, what
   calls this function. There are still no findings. A team that ships
   with agents gets the most from this rung, because the agent asks
   before it changes something.
3. Compare against a document you already keep. Run `suss contract`
   over an OpenAPI document, a Prisma schema or a deploy template, then
   `check`. The first findings appear here. `suss init` sets up this
   rung and the first one in a single step.
4. Cross the boundary. Add the consumer side: a client pack, a
   frontend package, a queue consumer. Findings now say which caller
   breaks. This is where a `.sussignore` starts to matter.
5. Gate. Run `check --fail-on error` in CI and `inspect --diff` on
   every pull request. A reviewer reads the behavior diff first.
6. Reuse the summaries. Give them to agents as context, generate
   endpoint documentation from them, or list the paths a test suite
   should cover.

The MCP rung comes before contracts on purpose. You can ask a single
service with no spec and no consumer what it does, and a team that
adopted an agent last month can use that today.

## What changes on the pages

- README first screen: the description line, a tagline, the two
  commands (`extract` then `inspect`) with the MCP config block next
  to them, then one `inspect --diff` rendering with a sentence saying
  what it caught. Below that, what you use it for, with the uses on a
  single service first and the uses across boundaries after. Then the
  ladder in six lines, linking to the guide. The list of four surfaces,
  the pack table and the install notes move down to a reference
  section.
- Docs home page: the same message in the hero and the feature cards.
  The first card is the pull request diff and the second is the MCP
  server. After those come who breaks, then spec drift.
- Adoption guide: the ladder above, one section per rung. Each section
  has the command, what it tells you, what it costs and what a false
  positive looks like at that rung. The guide also covers the workflow
  questions the current docs leave open: where summary files live, who
  runs `extract` in a repository with several services, how to triage
  a finding, and how to tell a suss miss from a bug in the code.

## Risks

- Readers could take this positioning as a claim about agents that
  suss cannot back up. Mitigation: the demonstration, the paragraph on
  limits, and never naming a vendor on the page.
- A reader tries the first rung on a stack suss reads poorly and
  leaves. Mitigation: the README lists the covered frameworks in plain
  words, and the guide's first rung explains what an empty or thin
  result means and how to tell whether the stack or the setup caused
  it.
- People searching for "review AI generated code" expect a reviewer
  backed by a model. Mitigation: the comparison and use-case pages say
  at the top that suss is deterministic and what that gives you. The
  reader who wanted a model leaves quickly, and the one who wanted a
  check stays.
