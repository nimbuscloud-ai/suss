# @suss/framework-sqlalchemy

Says which calls a Python body makes against the database, for a project
using SQLAlchemy.

## What this package is

A pattern pack. It states the types SQLAlchemy hands back from a query and
the methods that change what is stored, and the Python adapter does the
matching.

```ts
import { flaskRestxFramework } from "@suss/framework-flask-restx";
import { withSqlalchemy } from "@suss/framework-sqlalchemy";

const pack = withSqlalchemy(flaskRestxFramework({}), {
  storageSystem: "postgresql",
});
```

A web framework and a database library are separate libraries, and a project
picks both, so this composes onto whichever route pack a run already uses.
`sqlalchemyFramework` is there for a run that wants the storage patterns and
no routes.

`storageSystem` is yours to say. SQLAlchemy talks to Postgres, MySQL and
SQLite alike and the connection URL settles which, so the pack cannot.

## Why it matches on the return

A call chain matches when the method behind it says it returns one of
SQLAlchemy's query types. Matching on what a file imports would be simpler
and would find almost nothing. A measured Flask service imports `sqlalchemy`
in 50 files, and all 157 of its queries still go through a base class the
call sites never import:

```python
# in the project
class Base:
    @classmethod
    def query(cls) -> Query: ...

class Orders(Base): ...

# in a handler, importing neither the base nor SQLAlchemy
found = Orders.query().filter_by(id=1).first()
```

Following `Orders.query` to the method `Base` declares, and reading what that
method says it returns, finds all of them. On that service the run reports 74
database effects across 129 routes, naming the model each one is against.

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The three
calls above are one read, not three. The method the chain ends with tells a
read from a write, and the model it was called on becomes the table.

A `Session` is read the same way wherever the body gets it: a parameter
annotated `db: Session`, a local built by `Session()` or opened by `with
Session() as db:`, or a project function annotated `-> Session`. `db.add`,
`db.commit`, `db.merge` and the bulk methods are writes. `db.execute(stmt)`
records nothing of its own, since the statement it runs is its own chain, and
neither do `begin`, `rollback` or `close`.

A 2.0 statement is the operation its constructor says: `update(User).where(...).values(name="x")` is an update whose `fields` are the `values` keywords. `select(User.id)` puts the column in `fields`, and a keyword the chain picks rows by, `id` in `filter_by(id=1)`, goes in `selector`. A comparison written positionally, `where(User.id == 1)`, is not read.

Raw SQL handed to `text("...")` is read as its own effect, with the kind and
the table taken from the statement.

## License

Apache-2.0
