# Proposal: the fuzzer checks the checker

Status: direction decided (2026-08-05).

## The blind spot, by construction

This week's checker bug flagged every recorded-but-unnamed send as an
orphan to a queue named `""`. The fuzzer generates thousands of
programs and judges their summaries with three oracles, and none of
them could have seen it: nothing under `tools/differential` imports
`@suss/checker`. Extraction is fuzzed; the checker that consumes
extraction's output is not. The one seam that failed is the one seam
the harness cannot reach.

Three smaller holes are versions of the same thing, verification that
stops short:

- `check:self` appears in PR test plans and runs with
  `--fail-on none`. It cannot fail.
- Two of 165 test files execute the shipped binary, and the cache bug
  lived only in the shipped binary.
- The coverage ratchet compares line percentages. `semanticsAgree` is
  the primitive both checkers must agree through, and it has no direct
  coverage of its own contract. Its package's aggregate looks healthy,
  so the gap does not show up.

## The stage

Each shape family already knows what its generated program means. A new
final stage feeds the extracted summaries through `checkAll` and judges
the findings against that meaning. Where the family also declares a side
of its own, a template or a contract, that goes through too:

```ts
// queue family, wired scenario: producer and consumer both declared
expectFindings(result, {
  none: ["messageBusProducerOrphan", "messageBusUnused"],
});

// queue family, orphan scenario: producer only
expectFindings(result, {
  exactly: [{ kind: "messageBusProducerOrphan", count: 1 }],
});

// producer family, runtime-named scenario
expectFindings(result, {
  none: ["messageBusProducerOrphan"],   // the bug this week shipped
});
```

The `""` orphan bug becomes a generated counterexample on every pull
request instead of a dogfooding surprise. The cost is small: the checker
runs on in-memory summary sets in milliseconds, far below the
extraction each shape already pays for.

## The rest of the net, in order

1. **Wire the corpora into a gate.** The public dogfood targets are
   checked out and used only for profiling. A scheduled run extracts
   and checks them and compares counts against a committed baseline.
   That is the same kind of ratchet `check:dogfood` already uses on our
   own packages, and our own packages cannot exercise the framework
   packs at all.
2. **Give `check:self` teeth.** Triage its current findings once,
   suppress what is accepted, then raise `--fail-on` so it can fail.
   Until then it leaves PR test plans, mine included.
3. **Branch floors where wrongness is user-facing.** Per-file branch
   thresholds on the short list the review picked out: `boundaryKey.ts`
   (33% today), `describeBinding`, the provider-coverage matcher. This
   is not a blanket raise, only a floor on the files whose branches are
   claims.
