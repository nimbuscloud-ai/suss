# What a pack says about the boundary it found

Status: resolved. Step 1 shipped, step 2 stopped on its own condition,
step 3 turned out to be already fixed. The outcomes are at the end.

A discovery pack does two things. It finds a code unit, and it says which
boundary that unit serves. Which of the two ways it says the second one
depends on how it found the unit, and the two ways cover different ground.

**Through a callback.** A pack that discovers units with the `discoverUnits`
hook returns `DiscoveredCustomUnit`, which can state any of four bindings:

```ts
routeInfo?:    { method: string | null; path: string | null };
resolverInfo?: { typeName: string; fieldName: string };
channelInfo?:  { messageBus: MessageBusSemantics["messageBus"]; channel: string | null };
deployableUnit?: DeployableUnit;
```

cloudflare-workers uses it as a table, one row per trigger:

```ts
export const TRIGGERS: Record<string, TriggerShape> = {
  fetch:     { kind: "handler",  routeInfo:   { method: "*", path: null } },
  scheduled: { kind: "worker",   channelInfo: { messageBus: "cloudflare-cron",   channel: null } },
  queue:     { kind: "consumer", channelInfo: { messageBus: "cloudflare-queues", channel: null } },
  tail:      { kind: "consumer", channelInfo: { messageBus: "cloudflare-tail",   channel: null } },
};
```

**Through a declaration.** A pack that discovers units with a `DiscoveryMatch`
states its binding in `bindingExtraction`, which is typed:

```ts
export type BindingExtraction = {
  method: /* six sources */;
  path:   /* six sources */;
};
```

An HTTP method and an HTTP path, both required, and no way to say anything
else. A declarative pack whose boundary is a queue, a topic, or a GraphQL
field has nowhere to put it.

## Why that matters

`ast-link` in pack health reports a declared pack that reads the syntax tree,
and `discoverUnits` is exactly that. So a pack author whose boundary is not
REST is pushed toward the callback and then reported for using it. The two
NestJS packs took the other route: `decoratedRoute` and `decoratedMethod`
select their units through the same two helpers, `classDecoratorStandingFor`
and `decoratedCallablesOf`, and each hardcodes its own binding reading in the
adapter, one emitting `routeInfo` and the other `resolverInfo`.

Concretely, the pack this blocks today is a NestJS microservice pack.
`@EventPattern("order.placed")` on a decorated class is a consumer bound to a
channel. `decoratedRoute` is the right match for finding it and cannot say
what it is bound to, so the pack has to be written as a callback.

## What to change

Give `DiscoveryPattern` the binding vocabulary `DiscoveredCustomUnit` already
has, rather than inventing a second one.

```ts
export interface DiscoveryPattern {
  kind: string;
  match: DiscoveryMatch;
  bindingExtraction?: BindingExtraction;   // unchanged, still rest-only
  /** A binding the pattern states outright, for a boundary the match cannot read from the source. */
  binding?: DeclaredBinding;
  requiresImport?: string[];
}

type DeclaredBinding =
  | { semantics: "message-bus"; messageBus: MessageBusSemantics["messageBus"]; channel: ChannelSource }
  | { semantics: "graphql-resolver"; typeName: TypeNameSource; fieldName: FieldNameSource };

type ChannelSource =
  | { from: "decoratorArgument"; position: number }
  | { from: "literal"; value: string }
  | { from: "unstated" };
```

The NestJS microservice pack then declares:

```ts
{
  kind: "consumer",
  match: {
    type: "decoratedRoute",
    importModule: "@nestjs/microservices",
    classDecorators: ["Controller"],
    methodDecoratorRouteMap: { EventPattern: "event", MessagePattern: "message" },
  },
  binding: {
    semantics: "message-bus",
    messageBus: "nats",
    channel: { from: "decoratorArgument", position: 0 },
  },
}
```

## What this deliberately does not do

An earlier draft proposed replacing both of `BindingExtraction`'s source lists
with one flat `FieldSource` union and discriminating the whole type by
semantics. Review found four things wrong with it, and they are worth writing
down so nobody proposes it again.

**The readings in the tree are not single sources.** A NestJS route path is a
join of two decorators, `joinRoutePath(pathPrefix, pathSuffix)`, so
`@Controller("users")` with `@Get(":id")` gives `/users/:id`. A resolver's
type name is a three-level fallback, `typeMap[decorator] ?? classTypeName ??
null`, and reading it in the other order files every root operation under the
wrong type. A field name is a two-level fallback. A registered path composes a
mount prefix from an unrelated declaration. One source per field expresses
none of these, so `FieldSource` would have to grow a fallback chain and a join
operator, which is a small expression language.

**Two fields are sometimes read together.** `extractRouteInfoFromBinding`
special-cases method and path both being `fromArgumentProperty` at the same
position, resolves the object once, and returns null unless both halves read.
A per-field union has no word for that.

**Not every semantics field is a string.** `rest.declaredResponses` is
`number[]`, `functionCall.exportPath` is `string[]`, and `messageBus` and
`operationType` are enums. A string-producing extractor cannot fill them.

**The sources are not interchangeable across fields.** `fromArgumentLiteral`
under `path` runs the value through `pathFromUrlNode`, which strips a URL
origin and rewrites `${id}` to `{id}`. It is a REST path reading, not a
literal reading, and pointed at a channel name it would corrupt it. Flattening
the lists also deletes a coupling the current shape has: `registrationArgument`
means something only under a registration match, `filename` only under
`fileConvention`.

The two source lists do have one difference that looks like drift rather than
meaning: `fromRegistration.position` is `"methodName" | number` under `method`
and `number` under `path`. That is worth fixing on its own.

**The remaining variants stay as they are.** An earlier draft ended with a
step that moved every baked-in variant onto a declared binding. None of them
can go:

- `jsxElementRoute` decides whether a unit exists at all by reading the path,
  and composes it from the element's ancestors.
- `resolverMap` finds the function by walking through the type key and the
  field key, so the binding is the walk.
- `registrationTemplate` and `registrationLoop` emit one unit per entry in a
  binding list, so the binding is what multiplies the units.
- `packageExports` and `packageImport` fill `function-call` fields
  (`package`, `exportPath`) that no source list covers.
- `graphqlHookCall` and `graphqlImperativeCall` fill `graphql-operation` from
  a parsed GraphQL document.

`namedExport` states no binding and gets the generic `function-call` one.

## The boundary vocabulary, as it actually is

`packages/ir-core/src/semantics/registry.ts` is the authority. Eight members,
with a compile-time check tying the schema union to the behavior table:

| Semantics | Fields |
|---|---|
| `rest` | method, path, declaredResponses? |
| `graphql-resolver` | typeName, fieldName |
| `graphql-operation` | operationType, operationName? |
| `message-bus` | messageBus (enum), channel |
| `storage` | storageSystem, scope, container, accessPath |
| `runtime-config` | (none) |
| `function-call` | module?, exportName?, package?, exportPath? |
| `metric` | metricSystem, metricType |

Of those, `DiscoveredCustomUnit` covers three and `bindingExtraction` covers
one.

## Order

1. `binding` on `DiscoveryPattern`, `message-bus` only, with the NestJS
   microservice pack as the thing that proves it works. Verify on a repo
   somebody wrote, with the route count before and after.
2. `graphql-resolver`, and move nestjs-graphql onto it. This is the test of
   whether declared and baked-in readings can produce the same answer: the
   `typeMap[decorator] ?? classTypeName` precedence has to survive, and if
   expressing it needs a bespoke source, stop here.
3. Fix `fromRegistration.position` to be the same type on both sides.

## What this does not cover

The Python and Ruby adapters keep their own discovery types
(`PythonDiscoveryPattern`, `RubyDiscoveryPattern`), which share nothing with
`DiscoveryMatch`. Python's two route variants bundle `RouteConventions` and
router mounting, neither of which the TypeScript side has a concept of.
Whether those should converge is a separate question. A shared type would be
mostly optional fields that only one adapter reads.

`registrationTemplate`, `registrationLoop`, `packageExports` and
`packageImport` have no declaring pack, so nothing a user installs reaches
them. The first two need a pack option a project fills in with its own helper
name (#599). The second two are constructed by `tools/differential` instead.

## Outcomes

**Step 1 shipped.** `DiscoveryPattern.binding` exists, message-bus
only, and `@suss/framework-nestjs-microservices` is the pack that
proves it: an `@EventPattern` handler is a consumer on the channel its
decorator states. Against the official NestJS microservices sample the
handler is found where before there was nothing.

**Step 2 stopped, on the condition written above.** The resolver type
name is `typeMap[decorator] ?? classTypeName`, the field name is
`nameOption ?? methodName`, and the class type is read out of an arrow
function. Declaring those needs three bespoke compound sources that
fit this one shape, which is the expression language this document
already argued against. The stronger reason to stop: `decoratedMethod`
already states the whole reading as data in its match
(`methodDecoratorTypeMap`), so nestjs-graphql is not a callback,
pack health does not report it, and a declared form would rename
fields without deleting any adapter code.

**Step 3 was already fixed.** The `path` side of `BindingExtraction`
no longer has a `fromRegistration` variant at all; the route-path
rework replaced it with `fromArgument`. Only `method` still reads from
the registration, and its `"methodName" | number` type is right for
what it reads.
