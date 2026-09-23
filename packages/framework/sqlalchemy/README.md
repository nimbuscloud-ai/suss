# @suss/framework-sqlalchemy

This pack records which calls a Python body makes against the database,
for a project that uses SQLAlchemy.

## What this package is

A pattern pack. It declares the types SQLAlchemy returns from a query,
the methods that change what is stored, and the constructor a model's
field uses to reach another model. The Python adapter does the matching.

```ts
import { flaskRestxFramework } from "@suss/framework-flask-restx";
import { withSqlalchemy } from "@suss/framework-sqlalchemy";

const pack = withSqlalchemy(flaskRestxFramework({}), {
  storageSystem: "postgresql",
});
```

A project picks its web framework and its database library separately,
so this pack combines with whichever route pack a run already uses.
`sqlalchemyFramework` is for a run that wants the storage patterns and
no routes.

You have to set `storageSystem`. SQLAlchemy works with Postgres, MySQL
and SQLite, and the connection URL decides which, so the pack cannot
work it out.

From the CLI, the option comes from a config file. A bare
`-f sqlalchemy` stops with a message asking for one:

```sh
echo '{ "storageSystem": "postgresql" }' > suss.sqlalchemy.json
suss extract -f flask-restx -f sqlalchemy=suss.sqlalchemy.json
```

## Why it matches on the return

A call chain matches when the method behind it is declared to return one
of SQLAlchemy's query types. Matching on what a file imports would be
simpler, and would find almost nothing. One Flask service that suss was
measured on imports `sqlalchemy` in 50 files, yet all 157 of its queries go through
a base class that the call sites never import:

```python
# in the project
class Base:
    @classmethod
    def query(cls) -> Query: ...

class Orders(Base): ...

# in a handler, importing neither the base nor SQLAlchemy
found = Orders.query().filter_by(id=1).first()
```

Following `Orders.query` to the method `Base` declares, and reading its
declared return type, finds all of them. On that service the run reports
74 database effects across 129 routes, each with the model it is
against.

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The
three calls above make one read. The method at the end of the chain
decides whether it is a read or a write, and the model it was called on
becomes the table.

A `Session` is read the same way wherever the body gets it: a parameter
annotated `db: Session`, a local built by `Session()` or opened by `with
Session() as db:`, or a project function annotated `-> Session`. `db.add`,
`db.commit`, `db.merge` and the bulk methods are writes. `db.execute(stmt)`
records nothing itself, since the statement it runs is its own chain.
`begin`, `rollback` and `close` record nothing either.

The table is the model the call works on. `select(User)`, `select(User.id)`,
`db.get(User, 1)` and `db.query(User)` give it in their first argument, and
`select(func.count()).select_from(User)` gives it later in the chain.
`db.add(user)` takes it from what the function declares `user` to be: a
parameter annotated `user: User`, or a local assigned from `User(...)`,
`db.get(User, 1)`, `User.model_validate(data)`, or a project function
annotated `-> User | None`. A parameter annotated with an alias, such as
`current_user: CurrentUser` with `CurrentUser = Annotated[User,
Depends(get_current_user)]` in this module or another, is read as a `User`.
The pack tells a class from a variable by its case, `User` against `user`,
so a model written in lowercase is not read. `db.commit()` does not work on
a table of its own, and comes out with no container name.

A 2.0 statement's operation comes from its constructor. `update(User).where(...).values(name="x")` is an update whose `fields` are the `values` keywords. `select(User.id)` puts the column in `fields`, and a keyword the chain selects rows by, such as `id` in `filter_by(id=1)`, goes in `selector`. A comparison written positionally, `where(User.id == 1)`, is not read.

Raw SQL passed to `text("...")` is read as its own effect, with the kind
and the table taken from the statement.

## Relationships

`relationship`, imported from `sqlalchemy.orm`, declares that a model's
field reaches another model:

```ts
relationships: [{ module: "sqlalchemy.orm", name: "relationship" }]
```

The model comes from the field's annotation when it has one, with the
wrappers removed (`Mapped[Item]`, `Mapped[list["Item"]]`,
`Optional[Item]`, `Item | None`). Otherwise it comes from the call's
first argument, which is how `participants = relationship("Participant")`
is read. The callable has to come from `sqlalchemy.orm`, so a project
function called `relationship` does not match.

With that, `case.participants` resolves to `Participant`, and a call on
it works the same way as for any model suss has resolved.

## License

Apache-2.0
