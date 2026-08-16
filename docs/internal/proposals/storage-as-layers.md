# Storage as layers, not as a list of products

## Where this came from

Adding DynamoDB (#143) asked whether a table joins `storage-relational`
or gets a variant of its own. Answering it turned up something the
existing variant gets wrong, and the fix generalises past DynamoDB.

`storage-relational` says which database it is in three places at
once. Its `storageSystem` field is the transport, the dialect, and a
stand-in for the data model, all under one product name. That works while every
store we read is a SQL one. It stops working the moment a store
disagrees about any of the three, which DynamoDB does about the middle
one.

The relational pass reports a read of an undeclared column as an error,
because a SQL schema declares every column it has. DynamoDB declares
its key attributes and nothing else, so the same rule over a DynamoDB
table would report every ordinary attribute a caller reads. That is
one property, not one product, and it is the property that decides
whether the rule may run.

## The layers

HTTP is the closer analogy than the one we have been using. HTTP is a
transport, and REST and GraphQL are different contracts over it. Storage
splits the same way, into four things we already model separately
elsewhere.

**Transport.** How the bytes get there: the Postgres wire protocol, the
AWS SDK over HTTPS, RESP, Bolt. Today `transport` is set to a product name
instead.

**What identifies an item.** A table plus a primary key, a bucket plus an
object key, an index plus a document id. Two shapes turn up: a set of
key fields (relational, DynamoDB) or a key convention (S3, Redis),
where the structure is in the name itself. A key convention is a path
comparison, which is the same problem REST route matching already
solves, so `routePathAdmits` is the machinery, not a new one.

**What describes an item.** A field set that is exhaustive (a SQL
schema), a field set that is not (an Elasticsearch mapping with
`dynamic` on, a Mongo collection with a validator), or nothing at all
(a blob, a Redis string). This is the property the relational pass
depends on and never states.

**How a request selects.** A SQL `WHERE`, a DynamoDB key condition, a
query DSL, Cypher, Gremlin, SPARQL. We invented this concept already
for routing: `matchLanguage` says which language a condition is written
in so the matcher that owns it gets it, and a language with no matcher
is reported unknown rather than admitted or refused. Storage selectors
want exactly that rule.

## What the families do to the model

Walking the families is what tests it.

| family | identifies an item | describes an item | selector |
| --- | --- | --- | --- |
| Postgres, MySQL | key fields | exhaustive fields | SQL |
| DynamoDB | key fields | keys only | key condition |
| Mongo | key field | nothing, or a validator | query document |
| Elasticsearch | document id | fields, not exhaustive | query DSL |
| S3, GCS | key convention | nothing | exact key or prefix |
| Redis | key convention | nothing | exact key or pattern |
| Neptune, Neo4j | label or edge type | properties, rarely exhaustive | Gremlin, SPARQL, Cypher |

Two things the table shows that a per-product variant would have hidden.

Neptune speaks Gremlin and SPARQL, so the selector language belongs to
the access rather than to the store. Routing found the same thing: the
language sits on the match record, not on the router.

A container has more than one way in. A DynamoDB table has its global
secondary indexes, an Elasticsearch index has its aliases, and each has
its own key fields. So the addressed thing is a container plus an
access path, and a summary that records only the container cannot say
which one a query used.

## What this replaces

A variant per product family means a branch per family in every pass
that touches storage, which is the shape #122 already complains about
elsewhere. Four properties covers the seven families above, and the
checker dispatches on what a boundary declares about itself, the way
`sidesAgree`, `canPair`, and `exchangesHttpResponses` already work.

Concretely, a storage boundary states its container and access path,
whether its described fields are exhaustive, and its selector language.
Postgres and DynamoDB then differ by two declared properties rather
than by a name, S3 arrives as "no fields, the key convention is the
contract" rather than as a fourth variant, and Elasticsearch arrives as
"fields, not exhaustive" without a fifth.

## What it costs

`storage-relational` ships today and pairs Prisma, Drizzle, SQLAlchemy,
and ActiveRecord, so this is a migration rather than a fresh start. The
four packs that construct it pass a product name, and each would pass
its transport, its exhaustiveness, and its selector language instead,
which every one of them knows. Published summaries carry the old shape,
and the legacy reader already handles a schema that moved, the way it
did for backfilled ids.

The DynamoDB work in flight (#143) is the forcing case. Shipping it as
a narrow second variant is cheaper this week and costs the migration
later, once blob makes it three.
