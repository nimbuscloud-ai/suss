# Proposal: how a pack says a call talks to a database

Status: draft, seeking alignment. No implementation yet.

`effect-grammar.md` asks what belongs in the effect taxonomy. This asks
the narrower question underneath it: given that `interaction` with
`class: "storage-access"` already exists and TypeScript packs already
produce it, how does a Python or Ruby pack produce one.

Today it cannot. A pack for either language is

```ts
export interface PythonPack {
  name: string;
  protocol: string;
  discovery: PythonDiscoveryPattern[];
}
```

so it says where a route is and nothing about what a body does.
`#259` and `#260` gave both languages invocation effects, so every call
a handler makes is already recorded with the conditions that gate it.
Nothing turns one into a database read.

## What the calls look like

Counted across a 463 file Flask service:

```
157  .query().filter_by(...)      100  .all()
131  .first()                      49  .delete()
130  .update(...)                  26  session.execute(...)
 59  execute(...)                  19  session.commit()
```

The service imports `sqlalchemy` in 50 files, which makes an
import-keyed recognizer look like the answer. It would find almost none
of this, because `query` belongs to the project:

```python
class Base:
    @classmethod
    def query(cls, *columns) -> Query:
        session = get_service(service_keys.SQL_SERVICE).session()
        ...
```

Every model inherits it, every call site reads
`AccessPoints.query().filter_by(id=...).first()`, and no call site
imports anything from SQLAlchemy. The `Query` the wrapper returns is the
library's own, and so are the methods chained off it. The import is one
hop further away than a recognizer looks.

This is the shape that cost 48 routes in `#273`, where a project
subclassed `Namespace` and the pack only knew the library's own module.
Rails makes it the normal case rather than the exception, since
`Order.where(...)` is a method a project's model inherits from
ActiveRecord and never writes down.

## Three ways a pack could match

**By the name at the call site.** A pack lists `query`, `filter_by`,
`first`, and matches the text an invocation effect already records.
Nothing new is needed and it works today. It also fires on anything
else called `first`, and a project method named `update` is a database
write as far as anyone reading the summary can tell. Nothing says which
table, so a summary gains a category and no target.

**By where the callee is declared.** A pack says which module the
library is, and the resolution rules follow the call to the definition
behind it. This is what the TypeScript packs do through the type
checker, and both languages can now do it through facts: `#271` made a
class a value containing its methods, `#272` follows an argument into a
parameter, `#277` finds the definition behind a Ruby constant. It reads
the wrapper correctly, and stops at the wrapper: `query` is declared in
the project, so a pack keyed on `sqlalchemy` still matches nothing.

**By what the definition says it returns.** The wrapper is annotated
`-> Query`, and `Query` is imported from `sqlalchemy.orm` in the file
that declares the wrapper. So a pack says which library type it
is looking for, and a call matches when the method it resolves to says
it returns one. The library's name appears on the project's own hop,
which is what the corpus needs and what the first two miss.

Ruby has no annotation to read, so ActiveRecord needs the second one
against the ancestry the adapter already computes: a model is a class
whose ancestors reach `ActiveRecord::Base`, and a method called on one
is a database call.

## What to settle

1. Whether a pack lists shapes per library, or declares a library type
   and lets resolution do the matching. The second is fewer moving
   parts and needs the facts to be right; the first ships sooner and
   says less.
2. What a match produces. `storage-access` wants `kind`, `fields` and
   `selector`. `filter_by(id=x)` gives a selector, `update(**data)`
   gives neither, and a chain gives its kind at the end rather than at
   the call the recognizer fired on.
3. Whether a chain is one effect or several. `Model.query().filter_by(
   ...).first()` is one read written as three calls, and three effects
   would be wrong.
4. Raw SQL. About a sixth of the database work in the corpus is a
   string handed to `session.execute(text(...))`. Reading the string is
   a separate piece of work, and saying "this unit reads the database,
   through a query nobody parsed" may be the whole answer.

## Recommendation

Match on what the definition says it returns, for Python, and on the
ancestry for Ruby, since both read the project's own wrapper rather than
being defeated by it. Ship one library each, SQLAlchemy and
ActiveRecord, against a chain read as one effect. Leave raw SQL saying
that it happened and nothing about what it says.
