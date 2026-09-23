# @suss/framework-sqlmodel

This pack records which calls a Python body makes against the database,
for a project that uses SQLModel.

## What this package is

A pattern pack. It declares the types SQLModel returns from a query, the
methods that change what is stored, and the constructor a model's field
uses to reach another model. The Python adapter does the matching.

```ts
import { fastapiFramework } from "@suss/framework-fastapi";
import { withSqlmodel } from "@suss/framework-sqlmodel";

const pack = withSqlmodel(fastapiFramework({}), {
  storageSystem: "postgresql",
});
```

From the CLI, use `-f fastapi -f sqlmodel=suss.sqlmodel.json`, with the
file containing `{"storageSystem": "postgresql"}`. SQLModel works with
Postgres, MySQL and SQLite, and the connection URL decides which, so the
pack cannot work it out.

## Why a pack of its own

SQLModel is a layer over SQLAlchemy that re-exports the session and the
statement constructors from its own package root:

```python
from sqlmodel import Session, select

def read_items(session: Session):
    return session.exec(select(Item).offset(skip).limit(limit)).all()
```

The sqlalchemy pack matches a name by the module it was imported from, so
it finds nothing here. `Session` came from `sqlmodel` instead of
`sqlalchemy.orm`, and `select` came from `sqlmodel` instead of
`sqlalchemy`. This pack declares the same things for the `sqlmodel`
module, and adds `exec`, which is SQLModel's own name for running a
statement. It also includes the sqlalchemy patterns, since a SQLModel
project imports from `sqlalchemy` for anything SQLModel does not
re-export.

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The
method at the end of the chain decides whether it is a read or a write,
and the model it was called on becomes the table.

A `Session` is read the same way wherever the body gets it: a parameter
annotated `session: Session`, a local built by `Session(engine)` or opened
by `with Session(engine) as session:`, or a project function annotated
`-> Session`. A FastAPI project usually declares the parameter through an
alias in another module:

```python
# app/api/deps.py
SessionDep = Annotated[Session, Depends(get_db)]

# app/api/routes/items.py
def read_items(session: SessionDep, skip: int = 0):
```

The adapter follows `SessionDep` through the alias to `Session`, so the
handler is read as if it declared `session: Session`.

`session.add`, `session.commit`, `session.merge` and the bulk methods are
writes. `session.exec(stmt)` records nothing itself, since the statement
it runs is its own chain. `begin`, `rollback` and `close` record nothing
either.

A statement's operation comes from its constructor. `update(Item).where(...).values(title="x")` is an update whose `fields` are the `values` keywords. `select(Item.id)` puts the column in `fields`, and a keyword the chain selects rows by goes in `selector`. A comparison written positionally, `where(Item.id == 1)`, is not read.

Raw SQL passed to `text("...")` is read as its own effect, with the kind
and the table taken from the statement.

## Relationships

`Relationship`, imported from `sqlmodel`, declares that a model's field
reaches another model:

```python
class User(SQLModel, table=True):
    items: list["Item"] = Relationship(back_populates="owner")
```

```ts
relationships: [{ module: "sqlmodel", name: "Relationship" }]
```

The model comes from the annotation, with the wrappers removed. A forward
reference in quotes is resolved through the module's imports, the same
way the bare name would be. The callable has to come from `sqlmodel`, so
a project function called `Relationship` does not match. The sqlalchemy
pack's `relationship` is included as well, since a SQLModel project
imports from `sqlalchemy.orm` for anything SQLModel does not re-export.

With that, each element of `user.items` is an `Item`, and a `select` over
it or a call on an element works the same way as for any model suss has
resolved.

## License

Apache-2.0
