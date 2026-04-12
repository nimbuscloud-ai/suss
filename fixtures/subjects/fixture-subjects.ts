// Fixture file for subject resolution tests.
// Biome linting is disabled for fixtures/** so any patterns are fine here.

declare const db: any;

// Parameter reference: simple identifier that is a function parameter
export function paramSimple(userId: string) {
  if (userId) return userId;
  return null;
}

// Parameter reference: nested property access on param
export function paramPropertyAccess(req: any) {
  if (req.user.id) return req.user.id;
  return null;
}

// Local variable from a direct call expression
export function localFromCall(id: string) {
  const user = db.findUser(id);
  if (user) return user;
  return null;
}

// Local variable from an await call
export async function localFromAwaitCall(id: string) {
  const user = await db.findUser(id);
  if (user) return user;
  return null;
}

// Destructured from await call: const { user } = await db.findUser(id)
export async function destructuredFromAwait(id: string) {
  const { user } = await db.findUser(id);
  if (user) return user;
  return null;
}

// Element access expression: arr[0]
export function elementAccess(arr: string[]) {
  if (arr[0]) return arr[0];
  return null;
}

// Numeric literal used in comparison
export function numericLiteral(x: number) {
  if (x > 5) return "big";
  return "small";
}

// String literal used in comparison
export function stringLiteral(x: string) {
  if (x === "hello") return true;
  return false;
}

// Boolean literals
export function booleanLiterals(x: any) {
  const a = true;
  const b = false;
  return { a, b, x };
}

// Null keyword
export function nullKeyword(x: any) {
  if (x === null) return "null";
  return "not null";
}

// Unresolved: something that can't be resolved to a symbol
export function unresolvedExpr(x: any) {
  const fn = () => x;
  return fn;
}

// Deep property chain: req.body.user.id
export function deepPropertyChain(req: any) {
  if (req.body.user.id) return req.body.user.id;
  return null;
}

// Destructured without await: const { token } = getAuth()
export function destructuredFromCall(req: any) {
  const { token } = getAuth(req);
  if (token) return token;
  return null;
}
declare function getAuth(r: any): any;

// As expression (cast): (user as any).role
export function asExpression(user: any) {
  const role = (user as any).role;
  return role;
}

// Parenthesized expression
export function parenthesized(x: number) {
  if ((x)) return x;
  return 0;
}

// Deep dependency chain: a.b.c.findUser(id)
declare const services: any;
export function deepDependencyChain(id: string) {
  const user = services.db.users.findUser(id);
  if (user) return user;
  return null;
}

// Dependency with property access: getUser().name
export function dependencyThenProperty(id: string) {
  const user = db.findUser(id);
  if (user.name) return user.name;
  return null;
}
