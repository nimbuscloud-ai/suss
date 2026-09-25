# Resolution

## The facts an adapter supplies

A line per fact.

```
call(r, c)                  r is a call whose callee is c
callArg(r, k, a)            r passes a at position k
func(f)                     f is a function
reportImport(r, m)          r imports the module m (example adapter)
```

## What comes out

```
invokes(r, f)               the call r runs f
accountTotals(x)            a line outside the vocabulary section
```
