# Proposal: a managed database instance as a deployable

Status: draft, seeking alignment. Nothing here is built.

## What a deployable covers today

`DeployableUnitSchema` in `@suss/ir-core` is five values and a name:

```ts
deploymentTarget: z.enum([
  "lambda", "ecs-task", "container", "k8s-deployment", "worker",
]),
instanceName: z.string().min(1),
```

All five run code. The schema is reused whole by two protocols, and
`unitInvocation.ts` says why: "one deployed thing, two boundaries on
it". `runtime-config` is the unit's environment, keyed by
`(deploymentTarget, instanceName)`. `unit-invocation` is the same pair
as a callee. The third use is `identity.deployableUnit`, the stamp that
says which unit a summary's code runs in, which is what the flow walk
keys its nodes on.

An RDS instance is deployed, is declared in the same template, and is
on the same network, and none of the three uses covers it. The
Terraform pack has no entry for `aws_db_instance`, and the entries it
does have say a resource is a store, a channel, or a metric:

```hcl
resource "aws_db_instance" "community_staging" {
  engine  = "postgres"
  db_name = var.db_name
}
```

The instance is not a store. It is what stores live in. Nothing in the
vocabulary says that, so the tables inside it are identified without
it:

```ts
// packages/checker/src/storage/storagePairing.ts
// Pairing key: (storageSystem, scope, container, accessPath)
```

`scope` is a label. `@suss/contract-prisma`, `@suss/framework-prisma`,
`@suss/framework-drizzle` and `@suss/framework-mongoose` all take it as
a pack option and all default it to `"default"`, which
`boundary-semantics.md` documents as "our word for a source that named
no database". So two services that each keep a `users` table pair on
the table name, and only `sameService` keeps them apart, which needs
each summary to state a workspace.

## A managed service is a deployable, and nothing more

Proposal: `DeployableUnitSchema` gains `managed-service`, and the two
protocols that reuse it narrow to the five compute values instead of
accepting whatever the unit schema allows.

The narrowing is the part that matters. `runtime-config` and
`unit-invocation` both have exhaustive tables keyed by the target:
`CONFIG_READ_PREFIX` in the checker says a Lambda spells a config read
`process.env.` and a Worker spells it `env.`, and `PLATFORM_INJECTED`
in the CloudFormation reader lists the variables each platform sets by
itself. Neither question has an answer for a database. Widening the
shared enum without narrowing those two protocols would force an entry
into both tables, and every entry would be a statement nobody can
support. It would also make a database a legal callee of
`InvokeCommand`.

The alternative is a kind of unit of its own, a record beside
`DeployableUnit` rather than a value inside it. What that buys is that
the two protocols need no change at all. What it costs is every place
that already knows what to do with a deployable: the
`identity.deployableUnit` stamp, `unitIdentityKey`, `unitsByFile`, and
`scopedFlowNode`, which keys a flow node by document scope and instance
name. Each of those would need a second path for the second record, and
`deployedRefs` would have to work for both, since the whole point of
step 2 is that a variable points at the instance the way it already
points at a Lambda. One vocabulary with a narrower use in two protocols
is fewer changes than two vocabularies everywhere.

There is no `engine` field. The engine already has a word: a Postgres
instance contains stores whose `storageSystem` is `postgresql`, and the
Terraform packs already translate a provider's word into suss's, which
is what `vocabulary.json` beside each pack is for. An `engine` field on
`DeployableUnit` would be a field every compute unit leaves empty, and
`unitIdentityKey` would have to decide whether it belongs in the key.

The Terraform entry vocabulary gains one kind next to `storage`,
`message-bus` and `metric`: a resource that is a deployable unit, with
the attribute that says which database it declares. The instance's
summary records that under a `storageScope` metadata namespace, with
the storage system and the database name in it, the way a table records
`storageContract`.

## The database an instance declares is the scope

Proposal: `scope` is written in the boundary-name syntax, so a source
that knows which variable the connection URL comes from writes that
variable instead of a label.

`@suss/contract-prisma` already parses the datasource and reads only
the provider out of it:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

That reader writes `scope: "{DATABASE_URL}"`, which `parseBoundaryName`
classifies as a reference, the same as `{ORDER_TABLE}` on a container
today. Grounding is the storage protocol's `groundName`, which grounds
`container` now and grounds `scope` too, through the two channels
`behavioral-ir/src/deployment` already documents. `setTo` gives the
connection URL a template wrote as plain text, and the database name is
the last part of that URL's path. `pointsAt` gives the logical id of
the resource the deployment wires the variable to, and that is the
instance from step 1, whose `storageScope` metadata states the database
name. The second channel is why the instance has to be declared at all.

Where a pack cannot see the variable, the `scope` option stays and
means what it means today.

**A grounded scope refuses a pair only against another grounded scope.**
Both sides grounded, and the database names decide. Anything else pairs
the way it does now: `"default"` still means nobody said, and an
explicit label still pairs with an equal label. This is the rule the
flow pass already takes with `reaches` and `mayReach`, where something
nobody evaluated never turns a reachable answer unreachable. It also
means no project regresses. A project that labels its scopes today is
in the state it is in today until both of its sides ground, and a
project that grounds only its schema keeps pairing against code that
says nothing.

## The schema level stays a hole

Postgres puts a schema between the database and the table, `scope` is
one string, and `search_path` is usually set at run time, so code
states no schema and the grounded scope reaches the database only. A
`users` table under `analytics` and a `users` table under `public` stay
one container after all of this, and the proposal does not narrow that.

A future binding is a source that states the schema where a reader can
see it: Prisma's `@@schema`, which `blockAttributeToIndex` skips today,
a Drizzle `pgSchema` declaration, or a `search_path` in the connection
URL's options. When one of those is read, whether `scope`
becomes two fields or one string with a separator is the decision, and
making it now would be making it twice.

## Reaching an instance on the network

The flow walk is rules over per-hop facts. `FLOW_RULES` derives `step`
from `routesTo` with an admitted match, from `fronts`, and from
`belongsTo`, and `reaches` is its transitive closure over nodes keyed
by document scope and name. Each of those edges is a step a request
takes.

A security group rule sends no request, so an instance's network
attributes are a second relation over the same node set rather than
more `step` rows: which groups a unit is attached to, which group a
rule admits on which port, and which port an instance listens on.
"Which services can reach this database" is then a rule over those
facts, and a service whose storage access pairs with an instance no
rule admits it to is the finding. This step adds facts and one rule
set, and changes no published vocabulary, which is why it is last.

## Acceptance

Fixture cases, named here and built with the step that needs them:

- **`fixtures/managed-postgres`**: an `aws_db_instance` declaring
  `db_name`, a service whose template sets `DATABASE_URL` to it, and a
  Prisma schema whose datasource reads that variable. The instance
  appears as a deployable unit, and the service's accesses pair with
  the schema on the grounded database name rather than on `"default"`.
- **Two databases, one table name**: two services in the fixture, each
  with a `users` table and each wired to its own instance. Neither
  service's access pairs with the other's schema, with no workspace
  stated on either summary.
- **A label, unchanged**: a third service whose Prisma pack states
  `scope: "reporting"` on both sides and whose datasource states no
  variable. It pairs exactly as it does before the change, and its
  findings do not move.

## Cost

Step 1 changes published vocabulary. A summary that states
`managed-service` is refused by a `z.enum` in every build without the
value, and `normalizeLegacySummary` only reads older summaries forward,
so a version bump records the change without making an older reader
accept one. `SUMMARY_SCHEMA_VERSION` goes to 7, and the entry says a
deployable unit can be a managed service.

Step 2 changes what `scope` means, from a label a project picks to a
name that can be grounded. Every storage binding states it, the
compared keys the checker reports include it, and so do the intent
documents people commit, where `intent-ir` gives it the same
`"default"`. That is the expensive one to do twice.

Step 3 adds facts and rules and changes neither.

## Order

1. The vocabulary, and the Terraform entry for `aws_db_instance`. On
   its own it makes the instance visible in `suss inspect` and pairs
   nothing.
2. The grounded scope, which needs step 1 to have something to ask for
   a database name.
3. Network reachability, which needs the instance to be a node and
   changes nothing step 2 rests on.
