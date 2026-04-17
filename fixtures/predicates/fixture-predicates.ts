// Fixture file for predicate parsing tests.
// Biome linting is disabled for fixtures/** so any patterns are fine here.

// Simple identifier truthiness
export function checkTruthinessId(x: any) {
  if (x) return 1;
  return 0;
}

// Negation of identifier (!x)
export function checkNegationId(x: any) {
  if (!x) return 1;
  return 0;
}

// Double negation (!!x)
export function checkDoubleNegation(x: any) {
  if (!!x) return 1;
  return 0;
}

// Strict equality: x === null
export function checkStrictNullEq(x: any) {
  if (x === null) return 1;
  return 0;
}

// Strict inequality: x !== null
export function checkStrictNullNeq(x: any) {
  if (x !== null) return 1;
  return 0;
}

// Strict equality: x === undefined
export function checkStrictUndefinedEq(x: any) {
  if (x === undefined) return 1;
  return 0;
}

// Loose null check: x == null
export function checkLooseNullEq(x: any) {
  if (x == null) return 1;
  return 0;
}

// Loose null inequality: x != null
export function checkLooseNullNeq(x: any) {
  if (x != null) return 1;
  return 0;
}

// Numeric comparison: x > 5
export function checkGt(x: number) {
  if (x > 5) return 1;
  return 0;
}

// Numeric comparison: x >= 5
export function checkGte(x: number) {
  if (x >= 5) return 1;
  return 0;
}

// Numeric comparison: x < 5
export function checkLt(x: number) {
  if (x < 5) return 1;
  return 0;
}

// Numeric comparison: x <= 5
export function checkLte(x: number) {
  if (x <= 5) return 1;
  return 0;
}

// String equality: x === "hello"
export function checkStrEq(x: string) {
  if (x === "hello") return 1;
  return 0;
}

// Logical and: x && y
export function checkAnd(x: any, y: any) {
  if (x && y) return 1;
  return 0;
}

// Logical or: x || y
export function checkOr(x: any, y: any) {
  if (x || y) return 1;
  return 0;
}

// Nested and: a && b && c
export function checkNestedAnd(a: any, b: any, c: any) {
  if (a && b && c) return 1;
  return 0;
}

// Mixed and/or: a && b || c
export function checkMixedAndOr(a: any, b: any, c: any) {
  if (a && b || c) return 1;
  return 0;
}

// Call expression: isActive(user)
export function checkCallExpr(user: any) {
  if (isActive(user)) return 1;
  return 0;
}
declare function isActive(u: any): boolean;

// typeof on its own (rare standalone — should return null)
export function checkTypeof(x: any) {
  // typeof x itself is not a typical standalone condition — we use it in comparison
  if (typeof x === "string") return 1;
  return 0;
}

// Negation of a null check: !(user === null)
export function checkNegatedNullCheck(user: any) {
  if (!(user === null)) return 1;
  return 0;
}

// Negation of a truthiness check: !user.isActive
export function checkNegatedPropertyAccess(user: any) {
  if (!user.isActive) return 1;
  return 0;
}

// Property access as condition
export function checkPropertyAccess(user: any) {
  if (user.isActive) return 1;
  return 0;
}

// Element access as condition
export function checkElementAccess(arr: any) {
  if (arr[0]) return 1;
  return 0;
}

// Unknown/complex node: comma expression is not handled
export function checkComplexExpr(x: any, y: any) {
  // We'll use an unsupported expression type in our test by getting the condition text
  return x ? 1 : 0;
}

// And where left operand is null (so opaque wrapping of null is needed)
export function checkAndWithCall(user: any, isValid: any) {
  if (isActive(user) && isValid) return 1;
  return 0;
}

// Comparison that is NOT null/undefined — normal comparison
export function checkNonNullComparison(x: number) {
  if (x === 5) return 1;
  return 0;
}

// Negation of a nullCheck via !== null
export function checkNegatedNullNeq(user: any) {
  if (!(user !== null)) return 1;
  return 0;
}

// typeof x === "number"
export function checkTypeofNumber(x: any) {
  if (typeof x === "number") return 1;
  return 0;
}

// typeof x === "boolean"
export function checkTypeofBoolean(x: any) {
  if (typeof x === "boolean") return 1;
  return 0;
}

// typeof x === "function"
export function checkTypeofFunction(x: any) {
  if (typeof x === "function") return 1;
  return 0;
}

// Multi-arg call: compare(a, b)
declare function compare(a: any, b: any): boolean;
export function checkMultiArgCall(a: any, b: any) {
  if (compare(a, b)) return 1;
  return 0;
}

// Comparison with non-literal right: x > y
export function checkComparisonBothParams(x: number, y: number) {
  if (x > y) return 1;
  return 0;
}

// Mixed compound: (a && b) || (c && d)
export function checkMixedCompound(a: any, b: any, c: any, d: any) {
  if ((a && b) || (c && d)) return 1;
  return 0;
}

// Reversed typeof: "string" === typeof x
export function checkTypeofReversed(x: any) {
  if ("string" === typeof x) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Call inlining — local functions with single-expression bodies
// ---------------------------------------------------------------------------

// Arrow function with expression body
const isDeleted = (u: any) => u.deletedAt;
export function checkInlineArrow(user: any) {
  if (isDeleted(user)) return 1;
  return 0;
}

// Arrow function with negation
const isNotActive = (u: any) => !u.active;
export function checkInlineNegation(user: any) {
  if (isNotActive(user)) return 1;
  return 0;
}

// Arrow function with compound expression
const isAdminAndActive = (u: any) => u.role === "admin" && u.active;
export function checkInlineCompound(user: any) {
  if (isAdminAndActive(user)) return 1;
  return 0;
}

// Function declaration with single return
function hasPermission(u: any, perm: string) {
  return u.role === perm;
}
export function checkInlineDeclaration(user: any) {
  if (hasPermission(user, "admin")) return 1;
  return 0;
}

// Multi-return function — should NOT inline (stays opaque)
function complexCheck(u: any) {
  if (u.deletedAt) return false;
  return u.active;
}
export function checkNoInlineMultiReturn(user: any) {
  if (complexCheck(user)) return 1;
  return 0;
}

// Compound with both sides inlineable
const isVerified = (u: any) => u.emailVerified;
export function checkInlineCompoundBothSides(user: any) {
  if (isDeleted(user) && isVerified(user)) return 1;
  return 0;
}

// Nested inlining: outer calls inner
const isUsable = (u: any) => !isDeleted(u) && isVerified(u);
export function checkNestedInline(user: any) {
  if (isUsable(user)) return 1;
  return 0;
}

// Real-world: authorization guard with nested helpers
const hasRole = (u: any, role: string) => u.role === role;
const canAccess = (u: any, resourceOwnerId: string) =>
  hasRole(u, "admin") || u.id === resourceOwnerId;
export function checkDeepInline(user: any, ownerId: string) {
  if (canAccess(user, ownerId)) return 1;
  return 0;
}

// instanceof check
export function checkInstanceof(error: any) {
  if (error instanceof TypeError) return 1;
  return 0;
}

// in operator
export function checkInOperator(body: any) {
  if ("email" in body) return 1;
  return 0;
}

// Array.includes with literals
export function checkArrayIncludes(status: number) {
  if ([200, 201, 204].includes(status)) return 1;
  return 0;
}

// Array.includes with single element
export function checkArrayIncludesSingle(code: string) {
  if (["admin"].includes(code)) return 1;
  return 0;
}

// Negated instanceof
export function checkNegatedInstanceof(error: any) {
  if (!(error instanceof HttpError)) return 1;
  return 0;
}

// Negated in operator
export function checkNegatedIn(body: any) {
  if (!("email" in body)) return 1;
  return 0;
}

// Negated Array.includes
export function checkNegatedIncludes(status: number) {
  if (![200, 201].includes(status)) return 1;
  return 0;
}

declare class HttpError extends Error {
  status: number;
}
