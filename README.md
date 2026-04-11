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

## Status

Early development.
