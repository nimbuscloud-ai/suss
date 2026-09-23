# Model storage as layers instead of a list of products

## Where this came from

Adding DynamoDB (#143) raised the question of whether a table joins
`storage-relational` or gets a variant of its own. Answering it turned
up something the existing variant gets wrong, and the fix applies
beyond DynamoDB.

`storage-relational` records which database a store is in three places
at once. Its `storageSystem` field is used as the transport, the
dialect, and a stand-in for the data model, all under one product name.
That works while every store we read is a SQL one. It stops working as
soon as a store differs on any of the three, and DynamoDB differs on
the data model.

The relational pass reports a read of an undeclared column as an error,
because a SQL schema declares every column it has. DynamoDB declares
its key attributes and nothing else, so the same rule over a DynamoDB
table would report every ordinary attribute a caller reads. The
difference is one property of the store, whatever the product, and that
property decides whether the rule may run.

## The layers

HTTP is a closer analogy than the one we have been using. HTTP is a
transport, and REST and GraphQL are different contracts over it.
Storage splits the same way, into four things we already model
separately elsewhere.

**Transport.** How the bytes get there: the Postgres wire protocol, the
AWS SDK over HTTPS, RESP, Bolt. Today `transport` is set to a product
name instead.

**What identifies an item.** A table plus a primary key, a bucket plus
an object key, an index plus a document id. Two patterns turn up: a set
of key fields (relational, DynamoDB) or a key convention (S3, Redis),
where the structure is in the name itself. A key convention is a path
comparison. REST route matching already solves that problem, so
`routePathAdmits` can do the work and no new machinery is needed.

**What describes an item.** A field set that is exhaustive (a SQL
schema), a field set that is not (an Elasticsearch mapping with
`dynamic` on, a Mongo collection with a validator), or nothing at all
(a blob, a Redis string). The relational pass depends on this property
and never states it.

**How a request selects.** A SQL `WHERE`, a DynamoDB key condition, a
query DSL, Cypher, Gremlin, SPARQL. We already invented this concept
for routing. `matchLanguage` records which language a condition is
written in, so the condition goes to the matcher for that language. A
language with no matcher is reported unknown instead of admitted or
refused. Storage selectors need exactly that rule.

## What the families do to the model

Going through the families tests the model.

| family | identifies an item | describes an item | selector |
| --- | --- | --- | --- |
| Postgres, MySQL | key fields | exhaustive fields | SQL |
| DynamoDB | key fields | keys only | key condition |
| Mongo | key field | nothing, or a validator | query document |
| Elasticsearch | document id | fields, not exhaustive | query DSL |
| S3, GCS | key convention | nothing | exact key or prefix |
| Redis | key convention | nothing | exact key or pattern |
| Neptune, Neo4j | label or edge type | properties, rarely exhaustive | Gremlin, SPARQL, Cypher |

The table shows two things that a per-product variant would have hidden.

Neptune accepts both Gremlin and SPARQL, so the selector language
belongs to the access and not to the store. Routing found the same
thing: the language goes on the match record, and the router does not
have one.

A container has more than one way in. A DynamoDB table has its global
secondary indexes, an Elasticsearch index has its aliases, and each has
its own key fields. So the thing a query addresses is a container plus
an access path. A summary that records only the container cannot
record which one a query used.

## What this replaces

A variant per product family means a branch per family in every pass
that touches storage. #122 already complains about that pattern
elsewhere. Four properties cover the seven families above. The checker
dispatches on what a boundary declares about itself, the way
`sidesAgree`, `canPair`, and `exchangesHttpResponses` already work.

Concretely, a storage boundary states its container and access path,
whether its described fields are exhaustive, and its selector language.
Postgres and DynamoDB then differ by two declared properties instead of
by a name. S3 comes in as "no fields, the key convention is the
contract" instead of as a fourth variant. Elasticsearch comes in as
"fields, not exhaustive" without needing a fifth.

## What it costs

`storage-relational` ships today and pairs Prisma, Drizzle, SQLAlchemy,
and ActiveRecord, so this is a migration and not a fresh start. The
four packs that construct it pass a product name. Each would pass its
transport, its exhaustiveness, and its selector language instead, and
every one of them has that information. Published summaries use the old
layout, and the legacy reader already handles a schema that moved, as it
did for backfilled ids.

The DynamoDB work in progress (#143) forces the decision. Shipping it
as a narrow second variant is cheaper this week, but it means paying
for the migration later, once blob storage makes it three variants.
