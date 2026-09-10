# @suss/framework-sqlmodel

Says which calls a Python body makes against the database, for a project
using SQLModel.

## What this package is

A pattern pack. It states the types SQLModel hands back from a query and
the methods that change what is stored, and the Python adapter does the
matching.

```ts
import { fastapiFramework } from "@suss/framework-fastapi";
import { withSqlmodel } from "@suss/framework-sqlmodel";

const pack = withSqlmodel(fastapiFramework({}), {
  storageSystem: "postgresql",
});
```

From the CLI, `-f fastapi -f sqlmodel=suss.sqlmodel.json`, with the file
saying `{"storageSystem": "postgresql"}`. SQLModel talks to Postgres, MySQL
and SQLite alike and the connection URL settles which, so the pack cannot.

## Why a pack of its own

SQLModel is a layer over SQLAlchemy that re-exports the session and the
statement constructors from its own package root:

```python
from sqlmodel import Session, select

def read_items(session: Session):
    return session.exec(select(Item).offset(skip).limit(limit)).all()
```

The sqlalchemy pack matches a name on the module it was imported from, so it
sees nothing here: `Session` came from `sqlmodel`, not `sqlalchemy.orm`, and
`select` from `sqlmodel`, not `sqlalchemy`. This pack says the same things
about the `sqlmodel` module, adds `exec`, which is SQLModel's own name for
running a statement, and includes the sqlalchemy patterns, since a SQLModel
project reaches into `sqlalchemy` for what SQLModel does not re-export.

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The
method the chain ends with tells a read from a write, and the model it was
called on becomes the table.

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

The adapter follows `SessionDep` to `Session` through the alias, so the
handler is read as one declared `session: Session`.

`session.add`, `session.commit`, `session.merge` and the bulk methods are
writes. `session.exec(stmt)` records nothing of its own, since the statement
it runs is its own chain, and neither do `begin`, `rollback` or `close`.

A statement is the operation its constructor says: `update(Item).where(...).values(title="x")` is an update whose `fields` are the `values` keywords. `select(Item.id)` puts the column in `fields`, and a keyword the chain picks rows by goes in `selector`. A comparison written positionally, `where(Item.id == 1)`, is not read.

Raw SQL handed to `text("...")` is read as its own effect, with the kind and
the table taken from the statement.

## License

Apache-2.0
