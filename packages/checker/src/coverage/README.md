# coverage/

Two checks run here, and they ask two different questions of the same paired summaries.

`checkProviderCoverage` asks whether consumer branches handle every status the provider can produce, including sub-cases where the provider distinguishes outcomes within the same status code. A status covered by nothing is a smell rather than a defect, so it reports at warning.

`checkResponseMisread` asks whether a consumer path would misread a response the provider sends: the path runs on the response, reads a field its body does not carry, and nothing on the path tells that response apart from one that does carry the field. That claim states the input and the wrong result, so it reports at error.

## Place in the pipeline

`checkAll()` runs both after pairing, over paired (provider, consumer) summaries.

They emit `unhandledProviderCase`, `misreadProviderResponse` and `lowConfidence` findings.

## Key files

- `providerCoverage.ts:checkProviderCoverage` is the coverage entry point. It analyzes sub-cases when several provider branches share a status code.
- `responseMisread.ts:checkResponseMisread` is the misread entry point.
- `responseMatch.ts:extractResponseStatus` pulls a literal status code out of a transition's response output.
- `responseMatch.ts:consumerExpectedStatuses` collects literal status numbers from consumer predicates.
- `responseMatch.ts:refLooksLikeStatus` is the heuristic for whether a ValueRef points at something that looks like a status property.
- `statusRanges.ts:consumerHandlesStatus` says whether any consumer branch handles one status, by the number or by a range.
- `contentDiscrimination.ts:consumerDiscriminatesByContent` says whether the consumer tells a status apart by a body field rather than by the status code.
- `contentDiscrimination.ts:bodyFieldsConsumerTests` collects the body fields the consumer's guards test anywhere, which the misread check treats as discriminators rather than as reads.

## What counts as covering a status

`providerCoverage.ts:coverageOf` is the one place that decides it, and four things count.

- **A branch admits the status.** Its guard compares against that number (`res.status === 404`), or it is a range that includes it (`!res.ok`). `statusRanges.ts` does this part.
- **A fall-through covers the 2xx class.** A consumer branch with no guard on it at all is the success path, so it covers 2xx and nothing else. Letting it cover every status would be wrong on exactly the code this check exists to find: dub's `handleBanLink` fires a `DELETE` inside `toast.promise`, never reads the response, and comes out as one unguarded branch. Widening the fall-through to the whole space would call its 404 handled.
- **A guard on a body field only the failing status returns.** `if (res.error) toast.error(res.error)` after `.then((r) => r.json())` handles the 404 that comes back as `{ error }`, because a 200 from the same provider has no `error` on it. The field has to be one no 2xx body includes; a field both halves return tells the two apart for nobody, and counting it would swallow the finding above.
- **A catch, on a client that throws.** axios and ky reject on a non-2xx, so the caller never sees a response to guard on and every failure reaches its `catch`. `fetch` returns the response instead, so the same `catch` there covers nothing. `metadata.http.failureDelivery` is how the pack says which it is.

## What counts as a misread

`checkResponseMisread` fires when three things line up on one consumer path: the path runs on a response, the path reads a field, and the response's body provably has no such field. Each leg is deliberately narrow, because an error-severity kind lives or dies by its precision on the measured corpus.

- **Which responses a path runs on.** A status guard or a range admits its statuses, through the same `branchHandlesStatus` reading coverage uses, so the two checks never disagree about where a branch applies. The fall-through path runs on the 2xx class. A branch whose guard requires a body field to be truthy, or equal to something, never runs on a response whose body cannot supply that field.
- **Which reads count.** The fields on a transition's `expectedInput`, past the client's body accessor, minus every field any of the consumer's guards test. A tested field is a discriminator: `if (res.error)` reads `error` to tell the failure body apart, and getting undefined on the 200 is the answer it wanted. The exclusion is consumer-wide because the extractor attributes a read inside a callback to every path through it, so a guarded read shows up on the fall-through's `expectedInput` too. dub's `refresh-domain.tsx` is the shape this protects: the corpus's one false error before this check existed. Fields a failure body marks the case with come off claims about a 2xx for the same reason, whether or not a guard tests them.
- **When absence is proven.** A closed record without the field. A record with spreads, a dictionary, or an opaque shape claims nothing, and a union lacks the field only when every variant does. When the provider returns one status with several bodies, every one of them has to lack the field, because a variant that includes it makes the read speculative rather than wrong, and the untested-discriminator warning in `semanticBridging` already covers that.

The provider's responses are its extracted transitions. In a pair against an OpenAPI or ts-rest document, the document's summary contains the declared responses as transitions, so a declared body is compared the same way an extracted one is. A response declared as a range is one response that may arrive with any status in it: a branch on 404 runs on a declared `4XX`, the absence proof takes in every response the same status may arrive with (a declared `404` and a declared `4XX` alike), and overlapping declarations are claimed once, under the most specific label. An independent `declaredContract` on an extracted provider is deliberately not read here: the implementation may send more than it declared, so a read beyond the declaration is `checkConsumerContract`'s warning, not a misread.

## Ranges, and why they are read apart from numbers

`if (!res.ok) { toast.error(...); return }` handles every non-2xx status. The extractor records `res.ok` as `status >= 200 && status <= 299`, so a check that reads only `status === N` sees a consumer that handles nothing, and reports every status the provider can send. That one shape produced 23 of the 68 error-severity `unhandledProviderCase` findings measured over the public corpora, all of them false.

`statusRanges.ts` describes a branch as a set of status codes and combines predicates as sets: `and` intersects, `or` unions, a negation complements. Complementing needs both ends of the space, so the set is bounded at 100 and 599.

Two rules keep this from covering more than it should:

- **A predicate that says nothing about the status gives null**, and stays out of the intersection rather than counting as "any status". Without that, a consumer with no status check at all (`.then((r) => r.json())`, then a branch on a body field) would admit every status and no finding could ever fire.
- **An `or` with any null operand is null as a whole.** That operand can be true for any status, so the union cannot be trusted.

Comparisons against a single number stay with `consumerExpectedStatuses` and are read polarity-insensitively, the way they always were.

The provider can declare a range too. An OpenAPI response coded `4XX` reaches the checker as a transition with no status literal and the range under `metadata.http.statusRange` (`responseMatch.ts:extractResponseStatusRange` reads it). Such a transition is one declared response that may arrive with any status in the range, so the coverage question is asked once for the whole range: it is covered when any member is covered (a branch on 404, a `!res.ok` guard, a catch on a throwing client, a guard on a field only the range's body returns), and an uncovered range reports one finding rather than one per member. `contentDiscrimination.ts` reads the same range form, so a `2XX` body's fields count as success fields and a `4XX` body's fields can discriminate any status in 400 to 499.

An OpenAPI `default` response comes through as an `isDefault` transition with no status literal (`responseMatch.ts:isCatchAllResponse`). It covers every status the other transitions leave out, so `deadConsumerBranch` never fires against a provider that has one. The coverage pass does not ask the consumer to cover the default bucket: there is no concrete status to state an outcome about.

The range algebra reads one of them only on an arm the consumer wrote, which `StatusGuards.readsEquality` decides and `transition.isDefault` supplies. The `else` of `if (res.status === 404)` runs on every other status, so complementing the guard says what that arm covers. The path left over after `if (res.status === 200) { ...; return }` with no `else` is a fall-through, the consumer wrote nothing for the other statuses, and complementing there would call 404 handled by code that does not mention it.

`consumerExpectedStatuses` also settles a second, different question: which statuses does the consumer *name*. `deadConsumerBranch` and the contract check's "consumer expects a status the contract does not declare" both ask it. A range must not feed those, because `if (res.ok)` does not mean the consumer expects 203.

## Non-obvious things

- **Literal values only.** Status comparisons run on literal numeric values. Variables, function calls, and expressions emit `lowConfidence` instead of an error, because we can't prove a branch is unreachable without knowing the runtime value.
- **Sub-case discrimination is one-sided.** Provider conditions describe server-side state, and consumer conditions describe response fields. The check does not compare the two for equivalence, since flagging content mismatches is the body checker's job. A sub-case finding fires when the provider has several branches for one status and the consumer has a single catch-all for that status, meaning the consumer ignored the distinction.
- **Default branches absorb 2xx silently.** The check treats a consumer with an `isDefault` transition as covering all 2xx statuses. Even unusual cases (the provider returns 207 Multi-Status) come out covered when the default is there.
- **Predicate matching is three-state.** `predicatesMatch` returns `match` / `nomatch` / `unknown`. An `unknown` result (an opaque or unresolved predicate) turns into `lowConfidence` rather than committing in either direction.

## Sibling modules

- `contract/declaredContract.ts` supplies the status-accessor and success-accessor names used to read consumer predicates.
- `pairing/pairing.ts` supplies the SummaryPair tuples coverage runs against.
- `body/bodyCompatibility.ts` runs after coverage on the same status-grouped tuples, and reads `failureOnlyBodyFields` from here. A consumer's unguarded branch reading `error` is reading for the failure case, so that field comes off the shape before the 200 body is compared against it.
