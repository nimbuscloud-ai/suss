# coverage/

Two checks run here. They look at the same paired summaries and ask different questions.

`checkProviderCoverage` asks whether consumer branches handle every status the provider can produce. That includes sub-cases where the provider distinguishes outcomes within the same status code. A status that nothing covers is a smell and may not be a defect, so the check reports it at warning.

`checkResponseMisread` asks whether a consumer path would misread a response the provider sends. Three things must be true: the path runs on the response, it reads a field the response's body does not have, and nothing on the path tells that response apart from one that does have the field. A finding like that identifies both the input and the wrong result, so the check reports it at error.

## Place in the pipeline

`checkAll()` runs both after pairing, over paired (provider, consumer) summaries.

They emit `unhandledProviderCase`, `misreadProviderResponse` and `lowConfidence` findings.

## Key files

- `providerCoverage.ts:checkProviderCoverage` is the coverage entry point. It analyzes sub-cases when several provider branches share a status code.
- `responseMisread.ts:checkResponseMisread` is the misread entry point.
- `responseMatch.ts:extractResponseStatus` pulls a literal status code out of a transition's response output.
- `responseMatch.ts:consumerExpectedStatuses` collects literal status numbers from consumer predicates.
- `responseMatch.ts:refLooksLikeStatus` is the heuristic for whether a ValueRef points at something that looks like a status property.
- `statusRanges.ts:consumerHandlesStatus` returns whether any consumer branch handles one status, either by the number or by a range.
- `contentDiscrimination.ts:consumerDiscriminatesByContent` returns whether the consumer tells a status apart by a body field instead of by the status code.
- `contentDiscrimination.ts:bodyFieldsConsumerTests` collects the body fields the consumer's guards test anywhere. The misread check treats those as discriminators and does not count them as reads.

## What counts as covering a status

`providerCoverage.ts:coverageOf` is the one place that decides this. Four things count.

- **A branch admits the status.** Its guard compares against that number (`res.status === 404`), or it is a range that includes it (`!res.ok`). `statusRanges.ts` handles this part.
- **A fall-through covers the 2xx class.** A consumer branch with no guard on it at all is the success path, so it covers 2xx and nothing else. Letting it cover every status would be wrong on exactly the code this check exists to find. dub's `handleBanLink` fires a `DELETE` inside `toast.promise`, never reads the response, and comes out as one unguarded branch. If the fall-through covered the whole space, the check would call its 404 handled.
- **A guard on a body field that only the failing status returns.** `if (res.error) toast.error(res.error)` after `.then((r) => r.json())` handles the 404 that comes back as `{ error }`, because a 200 from the same provider has no `error` on it. The field has to be one that no 2xx body includes. A field that both kinds of response return does not tell them apart, and counting it would swallow the finding above.
- **A catch, on a client that throws.** axios and ky reject on a non-2xx, so the caller never sees a response to guard on and every failure reaches its `catch`. `fetch` returns the response instead, so the same `catch` there covers nothing. The pack declares which kind of client it is in `metadata.http.failureDelivery`.

## What counts as a misread

`checkResponseMisread` fires when three things line up on one consumer path: the path runs on a response, the path reads a field, and the response's body provably has no such field. Each of the three is kept narrow on purpose. A finding kind at error severity is only useful if it stays precise on the measured corpus.

- **Which responses a path runs on.** A status guard or a range admits its statuses. The check reads them with the same `branchHandlesStatus` that coverage uses, so the two checks never disagree about where a branch applies. The fall-through path runs on the 2xx class. A branch whose guard requires a body field to be truthy, or equal to something, never runs on a response whose body cannot supply that field.
- **Which reads count.** The reads are the fields on a transition's `expectedInput`, past the client's body accessor, minus every field any of the consumer's guards test. A tested field is a discriminator. `if (res.error)` reads `error` to recognise the failure body, and getting undefined on the 200 is the result the code wants. The exclusion applies across the whole consumer, because the extractor attributes a read inside a callback to every path through it, so a guarded read shows up on the fall-through's `expectedInput` too. dub's `refresh-domain.tsx` is the case this protects: it was the corpus's one false error before this check existed. For the same reason, fields that a failure body uses to mark its case are removed from claims about a 2xx, whether or not a guard tests them.
- **When absence is proven.** A closed record without the field proves it. A record with spreads, a dictionary, or an opaque shape proves nothing. A union lacks the field only when every variant does. When the provider returns one status with several bodies, every one of them has to lack the field. If one variant includes it, the read is only speculative, and the untested-discriminator warning in `semanticBridging` already covers that case.

The provider's responses are its extracted transitions. In a pair against an OpenAPI or ts-rest document, the document's summary contains the declared responses as transitions, so a declared body is compared the same way an extracted one is. A response declared as a range is one response that may arrive with any status in the range. A branch on 404 runs on a declared `4XX`. The absence proof takes in every response the same status may arrive with, so a declared `404` and a declared `4XX` both count. Overlapping declarations are claimed once, under the most specific label. This check does not read an independent `declaredContract` on an extracted provider, on purpose. The implementation may send more than it declared, so a read beyond the declaration gets `checkConsumerContract`'s warning and is not a misread.

## Status ranges

`if (!res.ok) { toast.error(...); return }` handles every non-2xx status. The extractor records `res.ok` as `status >= 200 && status <= 299`. A check that reads only `status === N` sees a consumer that handles nothing, and reports every status the provider can send. Over the public corpora, that one pattern produced 23 of the 68 error-severity `unhandledProviderCase` findings measured, and all 23 were false.

`statusRanges.ts` describes a branch as a set of status codes and combines predicates as sets: `and` intersects, `or` unions, and a negation complements. Complementing needs both ends of the space, so the set is bounded at 100 and 599.

Two rules keep this from covering more than it should:

- **A predicate that says nothing about the status gives null.** A null stays out of the intersection and does not count as "any status". Otherwise a consumer with no status check at all (`.then((r) => r.json())`, then a branch on a body field) would admit every status, and no finding could ever fire.
- **An `or` with any null operand is null as a whole.** That operand can be true for any status, so the union cannot be trusted.

Comparisons against a single number stay with `consumerExpectedStatuses`, which reads them without regard to polarity, as it always has.

The provider can declare a range too. An OpenAPI response coded `4XX` reaches the checker as a transition with no status literal and with the range under `metadata.http.statusRange` (`responseMatch.ts:extractResponseStatusRange` reads it). Such a transition is one declared response that may arrive with any status in the range, so the coverage question is asked once for the whole range. The range is covered when any member is covered, for example by a branch on 404, a `!res.ok` guard, a catch on a throwing client, or a guard on a field only the range's body returns. An uncovered range gets one finding, and its members do not get one each. `contentDiscrimination.ts` reads the same range form, so a `2XX` body's fields count as success fields and a `4XX` body's fields can discriminate any status from 400 to 499.

An OpenAPI `default` response comes through as an `isDefault` transition with no status literal (`responseMatch.ts:isCatchAllResponse`). It covers every status the other transitions leave out, so `deadConsumerBranch` never fires against a provider that has one. The coverage pass does not ask the consumer to cover the default bucket, because there is no concrete status to state an outcome about.

The range algebra complements a guard only on an arm the consumer wrote. `StatusGuards.readsEquality` decides that, and `transition.isDefault` supplies the input. The `else` of `if (res.status === 404)` runs on every other status, so complementing the guard gives what that arm covers. The path left over after `if (res.status === 200) { ...; return }` with no `else` is a fall-through, where the consumer wrote nothing for the other statuses. Complementing there would call 404 handled by code that does not mention it.

`consumerExpectedStatuses` also settles a second question: which statuses does the consumer *name*. `deadConsumerBranch` asks it, and so does the contract check's "consumer expects a status the contract does not declare". A range must not feed those, because `if (res.ok)` does not mean the consumer expects 203.

## Gotchas

- **Literal values only.** Status comparisons run on literal numeric values. Variables, function calls, and expressions emit `lowConfidence` instead of an error, because the checker can't prove a branch is unreachable without knowing the runtime value.
- **Sub-case discrimination is one-sided.** Provider conditions describe server-side state, and consumer conditions describe response fields. The check does not compare the two for equivalence, since flagging content mismatches is the body checker's job. A sub-case finding fires when the provider has several branches for one status and the consumer has a single catch-all for that status, which means the consumer ignored the distinction.
- **Default branches absorb 2xx without a finding.** The check treats a consumer with an `isDefault` transition as covering all 2xx statuses. Unusual cases, such as a provider returning 207 Multi-Status, also come out covered when the default is there.
- **Predicate matching has three states.** `predicatesMatch` returns `match` / `nomatch` / `unknown`. An `unknown` result, from an opaque or unresolved predicate, turns into `lowConfidence` and does not commit in either direction.

## Sibling modules

- `contract/declaredContract.ts` supplies the status-accessor and success-accessor names used to read consumer predicates.
- `pairing/pairing.ts` supplies the SummaryPair tuples coverage runs against.
- `body/bodyCompatibility.ts` runs after coverage on the same status-grouped tuples, and reads `failureOnlyBodyFields` from here. When a consumer's unguarded branch reads `error`, it is reading for the failure case, so that field comes off the shape before the 200 body is compared against it.
