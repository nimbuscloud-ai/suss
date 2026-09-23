# Proposal: a managed database instance as a deployable

Status: draft, seeking alignment. Nothing here is built.

## What a deployable covers today

`DeployableUnitSchema` in `@suss/ir-core` has five values and a name:

```ts
deploymentTarget: z.enum([
  "lambda", "ecs-task", "container", "k8s-deployment", "worker",
]),
instanceName: z.string().min(1),
```

All five run code. Two protocols reuse the whole schema, and the
comment in `unitInvocation.ts` gives the reason: "one deployed thing,
two boundaries on it". `runtime-config` is the unit's environment,
keyed by `(deploymentTarget, instanceName)`. `unit-invocation` uses the
same pair for a callee. The third use is `identity.deployableUnit`, the
stamp that records which unit a summary's code runs in. The flow walk
keys its nodes on that stamp.

An RDS instance is also deployed, declared in the same template and on
the same network, but none of the three uses covers it. The Terraform
pack has no entry for `aws_db_instance`. The entries it does have
declare a resource as a store, a channel, or a metric:

```hcl
resource "aws_db_instance" "community_staging" {
  engine  = "postgres"
  db_name = var.db_name
}
```

The instance contains stores, and nothing in the vocabulary can record
that. So the tables inside it are identified without it:

```ts
// packages/checker/src/storage/storagePairing.ts
// Pairing key: (storageSystem, scope, container, accessPath)
```

`scope` is a label. `@suss/contract-prisma`, `@suss/framework-prisma`,
`@suss/framework-drizzle` and `@suss/framework-mongoose` all take it as
a pack option and all default it to `"default"`, which
`boundary-semantics.md` documents as "our word for a source that named
no database". Two services that each keep a `users` table therefore
pair on the table name. Only `sameService` keeps them apart, and it
works only when each summary states a workspace.

## Add a managed service to the deployable targets

Proposal: `DeployableUnitSchema` gains `managed-service`, and the two
protocols that reuse it narrow to the five compute values instead of
accepting whatever the unit schema allows.

The narrowing matters most. `runtime-config` and `unit-invocation` both
have exhaustive tables keyed by the target. `CONFIG_READ_PREFIX` in the
checker records that a Lambda reads config through `process.env.` and a
Worker through `env.`. `PLATFORM_INJECTED` in the CloudFormation reader
lists the variables each platform sets by itself. Neither table has an
answer for a database. If the shared enum widened and those two
protocols did not narrow, both tables would need an entry for a
database, and nobody could support any of those entries. A database
would also become a legal callee of `InvokeCommand`.

The alternative is a separate kind of unit: a record beside
`DeployableUnit` instead of a value inside it. With that, the two
protocols need no change at all. The cost falls on every place that
already handles a deployable: the `identity.deployableUnit` stamp,
`unitIdentityKey`, `unitsByFile`, and `scopedFlowNode`, which keys a
flow node by document scope and instance name. Each of those would need
a second path for the second record. `deployedRefs` would have to work
for both as well, because step 2 depends on a variable pointing at the
instance the way it already points at a Lambda. One vocabulary with a
narrower use in two protocols needs fewer changes than two vocabularies
everywhere.

There is no `engine` field, because suss already has a word for the
engine. A Postgres instance contains stores whose `storageSystem` is
`postgresql`. The Terraform packs already translate a provider's word
into suss's through the `vocabulary.json` beside each pack. An `engine`
field on `DeployableUnit` would be one that every compute unit leaves
empty, and `unitIdentityKey` would have to decide whether it belongs in
the key.

The Terraform entry vocabulary gains one kind next to `storage`,
`message-bus` and `metric`: a resource that is a deployable unit, with
the attribute that declares its database. The instance's summary
records that database under a `storageScope` metadata namespace, with
the storage system and the database name in it, the same way a table
records `storageContract`.

## The database an instance declares is the scope

Proposal: `scope` is written in the boundary-name syntax. A source that
can see which variable the connection URL comes from writes that
variable instead of a label.

`@suss/contract-prisma` already parses the datasource, and reads only
the provider from it:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

That reader would write `scope: "{DATABASE_URL}"`. `parseBoundaryName`
classifies it as a reference, the same as `{ORDER_TABLE}` on a
container today. The storage protocol's `groundName` does the
grounding. It grounds `container` today and would ground `scope` too,
through the two channels `behavioral-ir/src/deployment` already
documents. Through `setTo`, a template that wrote the connection URL as
plain text gives the URL, and the database name is the last part of its
path. Through `pointsAt`, the deployment gives the logical id of the
resource it wires the variable to. That resource is the instance from
step 1, and its `storageScope` metadata states the database name. The
instance has to be declared at all because of this second channel.

Where a pack cannot see the variable, the `scope` option stays and
means what it means today.

**A grounded scope refuses a pair only against another grounded scope.**
When both sides are grounded, the database names decide. Anything else
pairs the way it does now. `"default"` still means nobody said, and an
explicit label still pairs with an equal label. The flow pass already
follows the same rule with `reaches` and `mayReach`, where something
nobody evaluated never turns a reachable answer unreachable. It also
means no project regresses. A project that labels its scopes today
stays as it is until both of its sides ground. A project that grounds
only its schema keeps pairing against code that states no scope.

## The schema level stays unresolved

Postgres puts a schema between the database and the table. `scope` is
one string, and `search_path` is usually set at run time, so code
states no schema and the grounded scope reaches the database only. A
`users` table under `analytics` and a `users` table under `public` stay
one container after all of this, and the proposal does not narrow that.

A future binding would be a source that states the schema where a
reader can see it: Prisma's `@@schema`, which `blockAttributeToIndex`
skips today, a Drizzle `pgSchema` declaration, or a `search_path` in the
connection URL's options. Once one of those is read, the decision is
whether `scope` becomes two fields or one string with a separator.
Deciding it now would mean deciding it twice.

## Reaching an instance on the network

The flow walk is rules over per-hop facts. `FLOW_RULES` derives `step`
from `routesTo` with an admitted match, from `fronts`, and from
`belongsTo`. `reaches` is the transitive closure of `step` over nodes
keyed by document scope and name. Each of those edges is a step a
request takes.

A security group rule sends no request. So an instance's network
attributes go in a second relation over the same node set instead of
more `step` rows. The relation records which groups a unit is attached
to, which group a rule admits on which port, and which port an
instance listens on. "Which services can reach this database" is then
a rule over those facts. The finding is a service whose storage access
pairs with an instance that no rule admits it to. This step adds facts
and one rule set and changes no published vocabulary, so it comes last.

## Acceptance

Each fixture case below gets built with the step that needs it:

- **`fixtures/managed-postgres`**: an `aws_db_instance` declaring
  `db_name`, a service whose template sets `DATABASE_URL` to it, and a
  Prisma schema whose datasource reads that variable. The instance
  appears as a deployable unit, and the service's accesses pair with
  the schema on the grounded database name instead of on `"default"`.
- **Two databases, one table name**: two services in the fixture, each
  with a `users` table and each wired to its own instance. Neither
  service's access pairs with the other's schema, with no workspace
  stated on either summary.
- **A label, unchanged**: a third service whose Prisma pack states
  `scope: "reporting"` on both sides and whose datasource states no
  variable. It pairs exactly as it does before the change, and its
  findings do not move.

## Cost

Step 1 changes published vocabulary. A `z.enum` in every build without
the value refuses a summary that states `managed-service`.
`normalizeLegacySummary` only reads older summaries forward, so a
version bump records the change but cannot make an older reader accept
a newer summary. `SUMMARY_SCHEMA_VERSION` goes to 7, and its entry says
a deployable unit can be a managed service.

Step 2 changes what `scope` means, from a label a project picks to a
name that can be grounded. Every storage binding states it, and so do
the compared keys the checker reports. The intent documents people
commit state it too, and `intent-ir` gives it the same `"default"`.
Step 2 is the step that costs most to do twice.

Step 3 adds facts and rules and changes neither.

## Order

1. The vocabulary, and the Terraform entry for `aws_db_instance`. On
   its own it makes the instance visible in `suss inspect` and pairs
   nothing.
2. The grounded scope, which needs step 1 so that there is something to
   ask for a database name.
3. Network reachability, which needs the instance to be a node and
   changes nothing step 2 depends on.
