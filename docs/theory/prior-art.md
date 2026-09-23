---
title: Prior art
description: What suss takes from Design by Contract, compiler design, formal verification, Datalog program analysis and Daniel Jackson's concept design, and where it parts company with each.
---

# Prior art

## Design by Contract

Bertrand Meyer's [Design by Contract (1986)](https://en.wikipedia.org/wiki/Design_by_contract) is the idea suss extends: a caller and a callee have an agreement, and the agreement can be written down next to the code. suss keeps that idea and changes three things about how the agreement is produced.

Meyer's preconditions and postconditions are written by hand, so they drift away from the code. suss derives them from the implementation, so a summary cannot disagree with the code it describes. DbC assertions live inside one process, where caller and callee share a runtime. A `BehavioralSummary` is JSON with nothing language-specific in it, so the two sides can be an Express route in TypeScript and a queue consumer in Python. A DbC assertion is either true or false. suss also records what it could not decide: opaque predicates, confidence levels and gaps are all top-level output, and the checker still compares a low-confidence summary.

## Compiler design

The adapter is a compiler front end with a narrow job. It reads an AST, resolves symbols through the type checker, enumerates control-flow paths through the structured statements, and walks expression trees. All of that is standard. suss stops short of two things a compiler would do: it builds no control-flow graph and runs no data-flow analysis. It finds the places a function produces observable output, works out the conditions that gate each one, and pairs them into transitions. A CFG would capture more, but it would cost orders of magnitude more to build and maintain, and the checker's comparison only needs the cases. [Extraction algorithm](/theory/extraction-algorithm) goes through the five steps in detail.

## Formal verification

Preconditions, postconditions and the habit of stating what a program guarantees all come from formal verification. suss is deliberately less rigorous than any of it. A predicate can be opaque and a subject can go unresolved, and the tool still produces something useful when coverage is incomplete. suss does not try to prove anything about a behavioral summary, which is a structured description for downstream tools to reason over. Formal methods such as TLA+, Alloy and Design by Contract's own assertion language need a specification written by hand, and it goes stale the moment somebody forgets to update it. suss derives its description, and derives it again on every run.

## Datalog program analysis

There is a long line of work on expressing a whole-program analysis in Datalog: bddbddb for points-to analysis, Doop for Java, and Soufflé as the general engine. suss follows it with `@suss/datalog`, a small semi-naive evaluator with stratified negation, where rules are plain data.

Three pieces come straight out of that literature. Semi-naive evaluation joins each round only against the facts that were new in the round before. The on-demand rewrite in `deriveOnDemand` is magic sets (Bancilhon, Maier, Sagiv and Ullman, 1986): each derived relation gets a companion relation listing the rows somebody is waiting on, and a relation nothing asks for is never derived. The tag algebra is a provenance semiring (Green, Karvounarakis and Tannen, 2007). It lets `suss ask why` rebuild a proof by walking stored derivations backward, the way Soufflé's provenance mode does, without running a rule again.

suss differs in scope. Nothing in the engine refers to the IR or to any AST, so an adapter for a second language emits the same facts and gets every analysis unchanged. The two rule sets that ship are described in [Facts and rules](/theory/facts-and-rules) and [How suss follows a value](/theory/resolving-values).

## Concept design

Daniel Jackson's concept design describes software as independent concepts. Each concept has one purpose, private state, and a set of actions that make up its whole interface. Synchronizations connect concepts by firing one action when another fires.

suss lines up with that at the coarse level. A code unit plays the part of an action, and a transition is one case of that action. A cluster of units whose subjects trace back to the same state is a candidate concept. suss already emits the three things a sync is built from: a transition whose effects invoke another unit, the boundary binding that says where the call site is, and a condition on that transition whose subject traces back to a second concept's state.

suss differs on direction and on completeness. Jackson designs top-down from declared purposes. suss derives bottom-up from code, so a purpose is implicit, and a `contractDisagreement` finding is the nearest thing to "purpose violated". Jackson's model is closed and rules infrastructure out by fiat. suss leaves code unclassified and labels what it could not resolve, and it cannot rule infrastructure out, because infrastructure is part of the repository it reads. Naming those clusters and chaining syncs into workflows is not built. The full mapping is in a design record, [Concept design as the theoretical ground](https://github.com/nimbuscloud-ai/suss/blob/main/design/concept-design.md), which also covers the ways deriving concepts from code goes wrong and what a PRD looks like when read as a concept declaration.

## Design principles

1. **Inference over authoring.** Contracts are extracted from code. The extraction is the product.
2. **Staged degradation.** Where the extractor cannot decompose a condition, it falls back to opaque, keeps the source text and lowers confidence. It never fails and never fabricates.
3. **Opacity is data.** An opaque predicate or an unresolved subject stays in the summary, labeled for what it is. Later passes decompose what earlier ones could not, and the design aims to reduce opacity over time.
4. **Language-agnostic output.** A summary has the same structure whether it came from TypeScript, Python or Ruby, and downstream tools do not need to know which.
5. **Boundaries come apart into three layers.** Every summary is attached to a `BoundaryBinding` with separate transport, semantics and recognition. A new protocol adds a semantics variant, and the other two layers do not change.
6. **Declarative over imperative.** Framework support is data. Adding a framework should be about a hundred lines of `PatternPack` configuration.
7. **Layered coupling.** The IR has zero dependencies, the extractor depends only on the IR, and the adapter depends on the extractor and the compiler API. Each layer can be replaced without touching the others.

## References

- Bertrand Meyer, [Design by Contract](https://en.wikipedia.org/wiki/Design_by_contract) (1986).
- François Bancilhon, David Maier, Yehoshua Sagiv and Jeffrey Ullman, *Magic Sets and Other Strange Ways to Implement Logic Programs* (PODS, 1986).
- Todd Green, Grigoris Karvounarakis and Val Tannen, *Provenance Semirings* (PODS, 2007).
- Martin Bravenboer and Yannis Smaragdakis, *Strictly Declarative Specification of Sophisticated Points-to Analyses* (OOPSLA, 2009), the Doop system; and [Soufflé](https://souffle-lang.github.io/) for the engine design.
- Daniel Jackson, [*The Essence of Software: Why Concepts Matter for Great Design*](https://essenceofsoftware.com/) (Princeton University Press, 2021).
- Daniel Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NASA Formal Methods, 2022).
- Eagon Meng and Daniel Jackson, [*What You See Is What It Does: A Structural Pattern for Legible Software*](https://arxiv.org/abs/2508.14511) (SPLASH Onward!, 2025). Its framing, where concepts are independent and a sync is a separate rule, is the one suss follows most closely.
- The [MIT Software Design Group](https://sdg.csail.mit.edu/project/conceptual/) for the wider publication list.
