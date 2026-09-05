# terminals/

This layer matches function-body subtrees against pack-declared terminal patterns and extracts the form of the response (status code, body, exception type, message) from each match.

## Place in the pipeline

It runs once per discovered unit, after discovery and before assembly. It receives the unit's `func` plus the pack's `TerminalPattern[]`, and it returns one `RawTerminal` per statement that matched a terminal pattern. Assembly uses these to build the unit's `transitions` (one per output branch).

## Key files

- `index.ts:findTerminals` — orchestrator. Walks descendants with `forEachDescendant`, tries each pattern in order, first-match wins. Skips into nested function bodies (those have their own terminals via their own units).
- `index.ts:functionMayFallThrough` — detects implicit fall-through at the end of a function body (no explicit return/throw last).
- `index.ts:makeFallthroughTerminal` — synthesizes the implicit-return terminal when fall-through is detected and the pack opted into `functionFallthrough`.
- `returns.ts:tryMatchReturnShape` — matches `return { status, body }` patterns; the response-object terminal.
- `throws.ts:tryMatchThrowExpression` — matches `throw new Error(...)` patterns. Extracts constructor name + first string-literal argument as the message.
- `extract.ts` — shared field-extraction utilities used by the per-pattern matchers (status code from constructor name, body from property name, etc.).

## Non-obvious things

- **Expression-body arrows get a second chance.** `forEachDescendant` walks the body's children but doesn't visit the body itself. Expression-body arrows (`() => expr`) ARE the implicit return — if the descendant walk found nothing, the outer arrow is re-checked against `returnStatement` / `jsxReturn` matchers as a fallback.
- **First-match-wins ordering.** The order of the patterns in `pack.terminals` is how the user says which one should win. A pattern that's structurally a superset of another should come AFTER it (more general patterns last) so the specific match fires first.
- **Status-code extraction is layered.** Try `statusCode.from = constructor` (look up the constructor name in a `codes` map), then `statusCode.from = property` (read a named property), then `defaultStatusCode` (from extraction config), then null. Each pattern declares its own preference.
- **A status value is read by the evaluator.** `res.status(code)` and `{ status: code }` go through `@suss/values` with the resolution store, so a constant reached through a chain of names and files comes back as its number. A value that does not settle to one number is reported as `dynamic` with its source text. A status written as a choice (`created ? ACCEPTED : OK`) is still found structurally in `statusBranches.ts`, with only its arms read by the evaluator, because the condition is syntax the value domain does not model.
- **Thrown-message extraction is positional but lenient.** First string-literal arg wins regardless of position — handles `Error(message)`, `Error(code, message)`, and template-literal forms.
- **`functionFallthrough` is opt-in per pack.** HTTP handlers should NOT use it (a missing return is an actual bug there); React event handlers and `useEffect` bodies SHOULD (they implicitly return undefined). The pack opts in on a per-unit basis via `subUnits` declarations.
- **A terminal built from a call is not also an effect.** Every call in the body becomes an invocation effect, and assembly drops the ones that are a terminal node or a link in its receiver chain (`res.status(404)` inside `res.status(404).json(body)`). The comparison is by node, so a call on the same line as a terminal, or written as its argument, keeps its effect.
- **Method-chain matching unwinds outermost-in.** `parameterMethodCall` matches `res.status(200).json(body)` by walking the call chain from outside in, validating that the chain root is the parameter at the right position. Reverse direction would miss nested chains.

## Sibling modules

- `shapes/shapes.ts` — `extract.ts` calls `extractShape` on every return body and throw argument.
- `resolve/invocationEffects.ts` — both walk function bodies, but capture different things: terminals catches return/throw outputs; invocation effects captures bare side-effect calls.
- `discovery/shared.ts` — receives `DiscoveredUnit.func` and the pack's `TerminalPattern[]`.
