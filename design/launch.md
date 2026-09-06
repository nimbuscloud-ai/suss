# Launch plan

Who suss is for, where those people read, what to say in each place,
and in what order. The frame is in `positioning-2026-09.md`; this file
is the distribution.

## Prerequisites

Nothing below goes out until these exist, because every post links to
them.

1. The README first screen and the docs home page on the new frame.
2. The GitHub Action that posts `inspect --diff` as a pull request
   comment, and one public pull request showing it catch a dropped
   field in a large agent-written change. That screenshot is the
   headline image everywhere.
3. The site metadata: sitemap, canonical URLs, Open Graph image,
   `llms.txt`, page descriptions. Search Console verified.
4. The repo description, topics and homepage set.

## Audiences

- Engineers on a team that ships with a coding agent and has noticed
  review is the bottleneck. They want to know what a change does
  without reading all of it. Entry point: the Action and the pull
  request diff.
- Engineers who use Claude Code or Cursor and want the agent to know
  the codebase before it edits. Entry point: the MCP server. The
  measurement to cite: a smaller model with suss answered the
  reach questions a bigger model with grep could not, at a quarter of
  the cost.
- Backend engineers who keep an OpenAPI document or a deploy template
  and know it has drifted. Entry point: `suss contract` and `check`.
- Framework communities (Hono, Express, FastAPI, Rails). Entry point:
  `inspect` output on their framework, which reads like documentation
  of their own routes.

## Voice

Everything publishes under Matt's name and reads as something he
said. Plain sentences, the limits stated in the same post as the
claims, no vendor named as a target, no suggestion that agents write
worse code. Every post ends with what suss does not do yet: TypeScript
is furthest along, Python and Ruby read routes and fewer ORMs, and a
boundary is only checked inside one repository.

The limits paragraph is not a hedge. On Hacker News and in the
engineering subreddits it is the difference between a thread that
argues about the claim and a thread that tries the tool.

## Channels

### Hacker News

Show HN, with a title of the form "Show HN: Suss, static analysis that
says what your API does on every path". The body is four short
paragraphs: the volume problem in two sentences, what suss produces
(the `inspect` tree in words), the pull request diff with a link to
the screenshot, and the limits. Post on a weekday morning US time.
Answer every comment in the first three hours; a technical question
gets the `inspect` output that answers it, pasted inline.

### LinkedIn

First person, Matt's own account. One post on the review problem with
the screenshot, one on the MCP measurement, one on spec drift. A week
apart. Each is under two hundred words and links to the docs page for
that use, not to the repo root.

### Reddit

- r/ClaudeAI and r/cursor: the MCP angle. The config block, what the
  agent can ask, the measurement, and a link to the MCP page. These
  communities respond to a number and a config snippet more than to
  an argument.
- r/ExperiencedDevs: a discussion post, not an announcement. The
  question is how teams review changes they cannot read in full, what
  suss does about one part of it, and where it falls short. Expect to
  be told that the answer is smaller pull requests, and agree that it
  is when the team controls the size.
- Framework subreddits and Discords (r/node, r/typescript, r/FastAPI,
  r/rails, the Hono Discord): the `inspect` tree over a well-known
  open-source app in that framework, with one sentence on how to run
  it. No pitch beyond that.

### Newsletters

Submit to JavaScript Weekly, Node Weekly, TypeScript Weekly, Bytes,
Ruby Weekly, Python Weekly and TLDR. Each takes a one-line description
and a link; use the repo description verbatim and link to the docs
home page. Submit after the Hacker News post, since editors look for
what was already discussed.

### Directories

- The official MCP registry, Smithery and mcp.so for `@suss/mcp`.
- awesome-mcp-servers, awesome-static-analysis and awesome-openapi
  as pull requests, each following that list's format.
- GitHub Marketplace for the Action, once it is in its own repository.

### Filing bugs upstream

When suss finds a defect in an open-source project during a corpus
run, file it on that project with the `inspect` output that shows it,
and fix it if the fix is small. The issue links to the run, not to a
marketing page. This is the slowest channel and the one people trust
most.

## Search

The queries to be found for, grouped by the page that should come up
for each:

- The use-case page on review: "review AI generated code", "code
  review at scale", "verify code written by Claude Code", "verify code
  written by Cursor", "AI code review without an LLM".
- The MCP page: "mcp server for codebase understanding", "give Claude
  Code context about my codebase".
- The contract guides: "openapi spec drift", "detect breaking api
  changes typescript", "check code against openapi spec".
- One page per framework, each with the `inspect` tree for that
  framework: Hono, Express, Fastify, NestJS, Next.js, FastAPI, Flask,
  Rails.
- Comparison pages, one each: Pact, Optic, openapi-diff, Spectral,
  Semgrep. Each says what the other tool does, where suss overlaps,
  and where each is the right choice.

Every page gets a title under sixty characters and a description under
one hundred and sixty. Search Console is checked weekly for the first
two months for queries that reach a page which is not about them.

## Sequence

1. Merge the positioning, SEO and Action pull requests. Set the repo
   metadata.
2. Record the demonstration pull request and take the screenshot.
3. Submit to the MCP directories and open the awesome-list pull
   requests. These take days to land and cost nothing to start early.
4. Show HN.
5. Newsletters, the same week.
6. LinkedIn and Reddit over the following three weeks, one post at a
   time so each thread gets answered.
7. Framework pages and comparison pages as they are written, each one
   posted to the matching community when it lands.

## Measurement

What to look at, weekly:

- `npm` downloads of `@suss/cli` and `@suss/mcp`, separately. The MCP
  package is the one that says whether the agent angle lands.
- GitHub stars and, more usefully, issues opened by people who ran it.
  An issue that pastes `inspect` output is the best signal there is.
- Search Console impressions per page, and which queries reach a page
  that is not about them.
- Installs of the Action, once it is on the Marketplace.
