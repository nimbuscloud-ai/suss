# declaration-positions-ruby

One graphql-ruby type per file. Each declares one field named `value`,
and they differ only in where the `field` call is written inside the
class body.

Ruby runs a class body like any other code, so a `field` call can go
anywhere a statement can: inside an `if`, a `.each` block, a `begin`, or
a `class_eval`. A reader that only takes the body's own list of
statements finds the first row and loses the rest without reporting it.

This is the Ruby member of a set. `subject-positions` covers the same
kind of cases in TypeScript, and `subject-positions-python` in Python.
Those two test which expression is the app, because a route is
registered on an object. Ruby recognizes a type by what its class
inherits, so there is no object to identify, and the only question here
is where the declaration is written.

Four rows are here to record what suss cannot read, and each one's file
explains why: a field name computed from a loop variable, a resolver
defined with `define_method`, a field declared in an included module,
and a field declared on a class whose name comes from a variable.
