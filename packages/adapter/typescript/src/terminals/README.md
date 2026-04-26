# terminals/

Matches function-body subtrees against pack-declared terminal patterns and extracts the response shape (status code, body, exception type, message) from each match.

## Place in the pipeline

Runs per discovered unit, after discovery, before assembly. Receives the unit's `func` plus the pack's `TerminalPattern[]`. Returns one `RawTerminal` per matched terminal-shaped statement. Assembly uses these to build the unit's `transitions` (one per output branch).

## Key files

- `index.ts:findTerminals` — orchestrator. Walks descendants with `forEachDescendant`, tries each pattern in order, first-match wins. Skips into nested function bodies (those have their own terminals via their own units).
- `index.ts:functionMayFallThrough` — detects implicit fall-through at the end of a function body (no explicit return/throw last).
- `index.ts:makeFallthroughTerminal` — synthesizes the implicit-return terminal when fall-through is detected and the pack opted into `functionFallthrough`.
- `returns.ts:tryMatchReturnShape` — matches `return { status, body }` patterns; the response-object terminal.
- `throws.ts:tryMatchThrowExpression` — matches `throw new Error(...)` patterns. Extracts constructor name + first string-literal argument as the message.
- `extract.ts` — shared field-extraction utilities used by the per-pattern matchers (status code from constructor name, body from property name, etc.).

## Non-obvious things

- **Expression-body arrows get a second chance.** `forEachDescendant` walks the body's children but doesn't visit the body itself. Expression-body arrows (`() => expr`) ARE the implicit return — if the descendant walk found nothing, the outer arrow is re-checked against `returnStatement` / `jsxReturn` matchers as a fallback.
- **First-match-wins ordering.** Pattern order in `pack.terminals` is the user's precedence signal. A pattern that's structurally a superset of another should come AFTER it (more general patterns last) so the specific match fires first.
- **Status-code extraction is layered.** Try `statusCode.from = constructor` (look up the constructor name in a `codes` map), then `statusCode.from = property` (read a named property), then `defaultStatusCode` (from extraction config), then null. Each pattern declares its own preference.
- **Thrown-message extraction is positional but lenient.** First string-literal arg wins regardless of position — handles `Error(message)`, `Error(code, message)`, and template-literal forms.
- **`functionFallthrough` is opt-in per pack.** HTTP handlers should NOT use it (a missing return is a real bug there); React event handlers and `useEffect` bodies SHOULD (they implicitly return undefined). The pack opts in on a per-unit basis via `subUnits` declarations.
- **`neverTerminal` flag.** Container-building calls (like `someBuilder()` returning an array/object) become invocation effects — the terminal-line dedup in assembly must NOT collapse them into the unit's terminal output. The flag tells assembly "this call's effects are independent of any terminal on the same line."
- **Method-chain matching unwinds outermost-in.** `parameterMethodCall` matches `res.status(200).json(body)` by walking the call chain from outside in, validating that the chain root is the parameter at the right position. Reverse direction would miss nested chains.

## Sibling modules

- `shapes/shapes.ts` — `extract.ts` calls `extractShape` on every return body and throw argument.
- `resolve/invocationEffects.ts` — both walk function bodies, but capture different things: terminals catches return/throw outputs; invocation effects captures bare side-effect calls.
- `discovery/shared.ts` — receives `DiscoveredUnit.func` and the pack's `TerminalPattern[]`.
