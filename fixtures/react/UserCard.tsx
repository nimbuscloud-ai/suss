// Minimal function component with early-return-null + JSX-element return.
// Produces two transitions:
//   1. `user == null` → returns null (render nothing)
//   2. default → returns a <div> (render output)
//
// Intentionally trivial — exercises the happy path for the jsxReturn
// terminal match without pulling in props typing or hook analysis.

interface User {
  id: string;
  name: string;
}

export default function UserCard({ user }: { user: User | null }) {
  if (!user) {
    return null;
  }
  return <div>{user.name}</div>;
}
