# suss

Static behavioral analysis for TypeScript. Given a function, suss answers: *under what conditions does this produce what outputs?*

```
suss extract -p tsconfig.json -f ts-rest -o summaries.json
suss inspect summaries.json
```

## What it does

suss reads your source code and produces **behavioral summaries** — structured, language-agnostic descriptions of every execution path through a handler, loader, or component:

```json
{
  "kind": "handler",
  "identity": { "boundaryBinding": { "method": "GET", "path": "/users/:id" } },
  "transitions": [
    {
      "conditions": [{ "type": "truthinessCheck", "subject": "user", "negated": true }],
      "output": { "type": "response", "statusCode": 404 }
    },
    {
      "conditions": [],
      "output": { "type": "response", "statusCode": 200 },
      "isDefault": true
    }
  ]
}
```

These summaries are the input to downstream tools: contract checkers, documentation generators, test case enumerators, impact analyzers.

## Packages

| Package | Description |
|---------|-------------|
| `@suss/behavioral-ir` | Types and utilities. Zero dependencies. Install this to consume summaries. |
| `@suss/extractor` | Assembly engine. Converts raw extracted structure into `BehavioralSummary`. |
| `@suss/adapter-typescript` | TypeScript language adapter via ts-morph. |
| `@suss/framework-ts-rest` | Framework pack for ts-rest. |
| `@suss/framework-react-router` | Framework pack for React Router loaders/actions/components. |
| `@suss/framework-express` | Framework pack for Express handlers. |
| `@suss/cli` | CLI wrapper. |

## Docs

- [`docs/motivation.md`](docs/motivation.md) — the problem, why existing tools don't catch it, prior art, design principles
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together, the vocabulary (with examples), package dependency rules
- [`docs/extraction-algorithm.md`](docs/extraction-algorithm.md) — the four extraction functions, pseudocode, edge cases, testing strategy
- [`docs/ir-reference.md`](docs/ir-reference.md) — type-by-type walkthrough of `@suss/behavioral-ir`
- [`docs/framework-packs.md`](docs/framework-packs.md) — how to write or modify a framework pack, pattern reference, worked Fastify example
- [`docs/style.md`](docs/style.md) — code conventions (Biome, TypeScript, tests, monorepo)
- [`docs/status.md`](docs/status.md) — phase-by-phase progress tracker, test counts, decisions log

## Status

Phase 1 (foundation) complete. Phase 2 (TypeScript adapter) not yet started. See [`docs/status.md`](docs/status.md) for details.

## License

This project is licensed under the [Apache 2.0 License](LICENSE).
