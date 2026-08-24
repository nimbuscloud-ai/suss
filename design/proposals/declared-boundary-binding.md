# What a pack says about the boundary it found

Status: draft, seeking alignment. One dead variant removed already; nothing
else here is implemented.

A discovery pack does two separate things. It finds a code unit, and it says
which boundary that unit serves. The `PatternPack` interface has a field for
each: `match` finds the unit, `bindingExtraction` says which boundary it serves.

Only three of the fourteen `DiscoveryMatch` variants use the second field.
For the other eleven, the boundary is worked out inside the adapter, in
the code that implements the variant. That is why the union keeps growing: a framework
whose boundary cannot be spelled in the existing `bindingExtraction` needs a
new match variant, and the binding goes in with it.

## What the field can say today

```ts
export type BindingExtraction = {
  method:
    | { type: "fromRegistration"; position: "methodName" | number; nameMap?: Record<string, string> }
    | { type: "fromExportName" }
    | { type: "fromContract" }
    | { type: "fromClientMethod" }
    | { type: "fromArgumentProperty"; position: number; property: string; default?: string }
    | { type: "literal"; value: string };
  path:
    | { type: "fromRegistration"; position: number }
    | { type: "fromArgumentProperty"; position: number; property: string }
    | { type: "fromFilename"; root: string; /* ... */ }
    | { type: "fromContract" }
    | { type: "fromClientMethod" }
    | { type: "fromArgumentLiteral"; position: number };
};
```

An HTTP method and an HTTP path, both required. That is one member of the
boundary vocabulary the IR already has:

| Semantics | Fields |
|---|---|
| `rest` | method, path |
| `graphql-resolver` | typeName, fieldName |
| `graphql-operation` | operation, name |
| `message-bus` | messageBus, channel |
| `storage` | storageSystem, container |
| `function-call` | (none) |

A GraphQL pack has nowhere to put `typeName` and `fieldName`, so
`decoratedMethod` reads them off the decorator in `decoratedMethod.ts` and
emits `resolverInfo`. A REST decorator pack has nowhere to say "the path is
the class decorator's first argument", so `decoratedRoute` reads it in
`decoratedRoute.ts` and emits `routeInfo`. The two files select their units
the same way, through the same two helpers, and differ only in the reading
they hardcode.

The two variant lists above also disagree with each other. `fromRegistration`
takes `position: "methodName" | number` under `method` and `position: number`
under `path`. `fromArgumentLiteral` exists for a path and not for a method.
Nothing about a source of a value depends on whether the value is a method or
a path, so the split buys nothing.

## What to change

One list of ways to read a value, and one binding per semantics that says
where each of its fields comes from.

```ts
type FieldSource =
  | { from: "registrationArgument"; position: number }
  | { from: "registrationMethodName"; nameMap?: Record<string, string> }
  | { from: "argumentProperty"; position: number; property: string; default?: string }
  | { from: "argumentLiteral"; position: number }
  | { from: "decoratorArgument"; on: "member" | "enclosingClass"; position: number }
  | { from: "memberName" }
  | { from: "exportName" }
  | { from: "filename"; root: string; dynamic?: "brackets" | "dollarPrefix"; /* ... */ }
  | { from: "contract" }
  | { from: "clientMethod" }
  | { from: "literal"; value: string };

type BindingExtraction =
  | { semantics: "rest"; method: FieldSource; path: FieldSource }
  | { semantics: "graphql-resolver"; typeName: FieldSource; fieldName: FieldSource }
  | { semantics: "message-bus"; channel: FieldSource; messageBus?: FieldSource }
  | { semantics: "function-call" };
```

nestjs-rest and nestjs-graphql then declare their bindings instead of getting
them from the adapter:

```ts
// nestjs-rest
bindingExtraction: {
  semantics: "rest",
  method: { from: "memberName" },   // via the decorator name map on the match
  path: { from: "decoratorArgument", on: "enclosingClass", position: 0 },
}

// nestjs-graphql
bindingExtraction: {
  semantics: "graphql-resolver",
  typeName: { from: "decoratorArgument", on: "enclosingClass", position: 0 },
  fieldName: { from: "memberName" },
}
```

Both then want the same match: an import gate, an enclosing-class marker, and
a set of member decorators. `decoratedMethod` and `decoratedRoute` become one
`decorated` variant, and one implementation replaces the two.

## What this is worth

The gain is not the variant count. It is that adding a framework stops
requiring a change to the central union and to the adapter. A pack author
picks a semantics, says where each field is written, and ships. Today the
same author reads fourteen variants, finds none that fits, and either adds a
fifteenth or writes a `discoverUnits` callback, which is TypeScript-only code
that `ast-link` in pack health then flags.

It also settles a question the current shape cannot answer: what a pack does
when its boundary is a queue or a topic. `message-bus` is in the IR and in no
pack's discovery.

## Order

1. `FieldSource` as one list, with the current `BindingExtraction` rewritten
   on top of it. No behaviour change, three packs edited.
2. `semantics` as the discriminator, with `rest` the only member. Same three
   packs.
3. `graphql-resolver`, then the `decorated` match, then nestjs-rest and
   nestjs-graphql onto it. Two adapter files become one.
4. The remaining baked-in variants, one at a time, each with its pack.

Steps 1 and 2 are mechanical and testable against the existing pack tests.
Step 3 is where the claim gets tested: if the merged `decorated` variant needs
a flag to tell a route from a resolver, the split was wrong and steps 3
and 4 should stop.

## What this does not cover

The Python and Ruby adapters keep their own discovery types
(`PythonDiscoveryPattern`, `RubyDiscoveryPattern`), which share nothing with
`DiscoveryMatch`. Python's two route variants bundle `RouteConventions` and
router mounting, neither of which the TypeScript side has a concept of.
Whether those should converge is a separate question. A shared type would
be mostly optional fields that only one adapter reads.

`registrationTemplate` and `registrationLoop` work, have tests, and no pack
declares them, so nothing a user installs can reach them. They need a pack
option a project fills in with its own helper name, which is its own piece of
work.
