# terminals/

This layer matches subtrees of a function body against the terminal patterns a pack declares. From each match it extracts the parts of the response: status code, body, exception type and message.

## Place in the pipeline

It runs once per discovered unit, after discovery and before assembly. It receives the unit's `func` and the pack's `TerminalPattern[]`, and returns one `RawTerminal` per statement that matched a terminal pattern. Assembly uses these to build the unit's `transitions`, one per output branch.

## Key files

- `index.ts:findTerminals` is the orchestrator. It walks descendants with `forEachDescendant` and tries each pattern in order, and the first match wins. It does not descend into nested function bodies, because those get their terminals through their own units.
- `index.ts:functionMayFallThrough` detects an implicit fall-through at the end of a function body, where the last statement is not a return or throw.
- `index.ts:makeFallthroughTerminal` builds the implicit-return terminal when it detects a fall-through and the pack opted into `functionFallthrough`.
- `returns.ts:tryMatchReturnShape` matches `return { status, body }` patterns, the response-object terminal.
- `throws.ts:tryMatchThrowExpression` matches `throw new Error(...)` patterns. It extracts the constructor name, and the first string-literal argument as the message.
- `extract.ts` contains field-extraction helpers that the per-pattern matchers share, such as the status code from a constructor name or the body from a property name.

## Gotchas

- **Arrows with an expression body get a second chance.** `forEachDescendant` walks the body's children but doesn't visit the body itself. For an arrow with an expression body (`() => expr`), the expression IS the implicit return. So if the descendant walk found nothing, the outer arrow is checked again against the `returnStatement` / `jsxReturn` matchers as a fallback.
- **The first match wins.** A pack author chooses which pattern wins through the order of `pack.terminals`. A pattern that is structurally a superset of another should come AFTER it, so the more specific match fires first.
- **Status-code extraction tries sources in order.** It tries `statusCode.from = constructor` (look up the constructor name in a `codes` map), then `statusCode.from = property` (read a named property), then `defaultStatusCode` from the extraction config, and then gives null. Each pattern declares its own preference.
- **The evaluator reads a status value.** `res.status(code)` and `{ status: code }` go through `@suss/values` with the resolution store, so a constant reached through a chain of names and files comes back as its number. A value that does not settle to one number is reported as `dynamic` with its source text. A status written as a choice (`created ? ACCEPTED : OK`) is still found structurally in `statusBranches.ts`, and the evaluator reads only its arms, because the value domain does not model the condition's syntax.
- **Thrown-message extraction goes by position but is lenient.** The first string-literal argument wins wherever it is. That handles `Error(message)`, `Error(code, message)`, and template-literal forms.
- **Each pack opts into `functionFallthrough`.** HTTP handlers should NOT use it, because a missing return is an actual bug there. React event handlers and `useEffect` bodies SHOULD use it, since they implicitly return undefined. The pack opts in per unit through `subUnits` declarations.
- **A terminal built from a call is not also an effect.** Every call in the body becomes an invocation effect. Assembly drops the calls that are a terminal node or a link in its receiver chain, such as `res.status(404)` inside `res.status(404).json(body)`. The comparison is by node, so a call on the same line as a terminal, or written as its argument, keeps its effect.
- **Method-chain matching unwinds from the outside in.** `parameterMethodCall` matches `res.status(200).json(body)` by walking the call chain from the outermost call inward, and checks that the chain root is the parameter at the right position. Walking the other way would miss nested chains.

## A return through a project helper

A handler often builds its response in a function of its own:

```ts
return logAndRespond("Queue unavailable.", { status: 503 });
```

with the helper in another file:

```ts
export function logAndRespond(body, { status = 200 } = {}) {
  console.info(body);
  return new Response(body, { status });
}
```

Nothing at the return matches the pack's `new Response(...)`, so on its own the handler gets no transitions, and the calls it makes land on no branch. `returnedHelper.ts:tryMatchReturnedHelper` reads the helper with the caller's own response patterns. Each of the helper's parameters is replaced by what this call passed, a destructured parameter included, and a parameter the call left out takes its default. Every response the helper builds becomes a response of the caller, placed at the caller's return. The terminal goes on the return statement and not on the call, so the call to the helper is still an effect and the helper's own summary is still reached through it. A status the helper cannot settle is recorded as `dynamic` with the helper's source text.

Which of the caller's patterns apply inside the helper:

- A pattern on a call by name, such as `NextResponse.json` or `Response`, applies as it is.
- A pattern on a method of the response object a handler was given, such as Express's `res.status(n).json(body)` or Hono's `c.json(body)`, applies at the helper's parameter that the caller passed that object to. A call that does not pass it gets nothing from the helper.
- A pattern that matches a returned object reads helpers itself, through `helperResolution.ts`, so it is not applied again here.
- A pattern that takes any returned value as the response, as Fastify's and the Workers pack's do, is left out. It would take every value the helper returns. When the helper builds no response, that pattern still applies to the caller's return as before.
- A throw is left out. A helper that throws makes the call throw wherever it is written.

A helper that returns another helper's call is followed again, up to four deep, and a helper is never read while it is already being read. A call to a parameter of the function is not followed. The function behind it is whatever the caller passed, such as the handler a wrapper calls, which composition splices in. A branch of the helper that cannot run with the arguments this call passed is left out, by the same test the returned-object reader uses.

## Sibling modules

- `shapes/shapes.ts` provides `extractShape`, which `extract.ts` calls on every return body and throw argument.
- `resolve/invocationEffects.ts` also walks function bodies, but it captures something else. Terminals capture return and throw outputs, and invocation effects capture calls made for their side effects.
- `discovery/shared.ts` provides the `DiscoveredUnit.func` and the pack's `TerminalPattern[]` that this layer receives.
