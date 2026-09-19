---
title: Prior art
description: What suss takes from Design by Contract, compiler design, formal verification, Datalog program analysis and Daniel Jackson's concept design, and where it parts company with each.
---

# Prior art

## Design by Contract

Bertrand Meyer's [Design by Contract (1986)](https://en.wikipedia.org/wiki/Design_by_contract) is the idea suss extends: a caller and a callee have an agreement, and the agreement can be written down next to the code. suss takes the framing and changes three things about how the agreement is produced. Meyer's preconditions and postconditions are hand-written, so they drift; suss derives them from the implementation, so a summary and the code it describes cannot disagree. DbC assertions live inside one process where caller and callee share a runtime; a `BehavioralSummary` is language-agnostic JSON, so the two sides can be an Express route in TypeScript and a queue consumer in Python. And a DbC assertion either holds or it does not, where suss records what it could not settle: opaque predicates, confidence levels, and gaps are all top-level output, and a low-confidence summary is still worth comparing.

## Compiler design

The adapter is a compiler front end for a narrow purpose. It reads an AST, resolves symbols through the type checker, enumerates control-flow paths through the structured statement language, and walks expression trees, all of which is standard. Where it stops is the interesting part. suss does not build a control-flow graph or run data-flow analysis. It finds the places a function produces observable output, works out the conditions that gate each one, and pairs them into transitions. A CFG would capture more and cost orders of magnitude more to build and maintain, and the comparison the checker does needs the cases rather than the graph. [Extraction algorithm](/theory/extraction-algorithm) is the five steps in detail.

## Formal verification

Preconditions, postconditions and the discipline of saying what a program guarantees come from formal verification, and suss is deliberately less rigorous than any of it. A predicate can be opaque, a subject can go unresolved, and the tool still produces something useful on incomplete coverage. A behavioral summary is not a proof and nothing in suss checks one: it is a structured description that downstream tools reason over. Where formal methods (TLA+, Alloy, Design by Contract's own assertion language) need a hand-authored specification that goes stale the moment somebody forgets to update it, suss derives its description and re-derives it on every run.

## Datalog program analysis

Using Datalog to express a whole-program analysis, rather than writing another traversal, is a long-standing line of work: bddbddb for points-to analysis, Doop for Java, and Soufflé as the general engine. suss follows it with `@suss/datalog`, a small semi-naive evaluator with stratified negation where rules are plain data. Three pieces come straight out of that literature. Semi-naive evaluation joins each round only against the facts that were new in the round before. The on-demand rewrite in `deriveOnDemand` is magic sets (Bancilhon, Maier, Sagiv and Ullman, 1986): each derived relation gains a companion relation saying which rows somebody is waiting on, and a relation nothing asks for is never derived. And the tag algebra is a provenance semiring (Green, Karvounarakis and Tannen, 2007), which is how `suss ask why` rebuilds a proof by walking stored derivations backward, the way Soufflé's provenance mode does, without re-running a rule. Where suss differs is scope: the engine knows nothing about the IR or any AST, so an adapter for a second language emits the same facts and gets every analysis unchanged. [Facts and rules](/theory/facts-and-rules) and [How suss follows a value](/theory/resolving-values) are the two rule sets that ship.

## Concept design

Daniel Jackson's concept design describes software as independent concepts, each with one purpose, private state, and actions that are its whole interface, wired together by synchronizations that fire one action when another does. suss lines up with that at the coarse level. A code unit plays the part of an action, and a transition is one case of that action rather than an action of its own. A cluster of units whose subjects trace back to the same state is a candidate concept. A sync is assembled from three things suss already emits: a transition whose effects invoke another unit, the boundary binding that says where the call site is, and a condition on that transition whose subject traces back to a second concept's state. suss parts company on direction and on completeness. Jackson designs top-down from declared purposes; suss derives bottom-up from code, so a purpose is implicit and a `contractDisagreement` finding is the nearest thing to "purpose violated". Jackson's model is closed and rules infrastructure out by fiat; suss leaves code unclassified, labels what it could not resolve, and cannot rule infrastructure out because it is reading a repository rather than a design. Naming those clusters and chaining syncs into workflows is not built. The full mapping, including the ways deriving concepts from code goes wrong and what a PRD looks like read as a concept declaration, is a design record: [Concept design as the theoretical ground](https://github.com/nimbuscloud-ai/suss/blob/main/design/concept-design.md).

## Design principles

1. **Inference over authoring.** Contracts are extracted from code rather than written by hand. The extraction is the product.
2. **Staged degradation.** Where the extractor cannot decompose a condition, it falls back to opaque, keeps the source text and lowers confidence. It never fails and never fabricates.
3. **Opacity is data.** An opaque predicate or an unresolved subject is a labeled surface in the summary rather than a discarded branch. Later passes decompose what earlier ones could not, and reducing opacity over time is a design axis.
4. **Language-agnostic output.** A summary has the same structure whether it came from TypeScript, Python or Ruby, and downstream tools never ask which.
5. **Boundaries come apart into three layers.** Every summary is attached to a `BoundaryBinding` with separate transport, semantics and recognition. A new protocol adds a semantics variant rather than reshaping the layers around it.
6. **Declarative over imperative.** Framework support is data. Adding a framework should be about a hundred lines of `PatternPack` configuration rather than a new module.
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
