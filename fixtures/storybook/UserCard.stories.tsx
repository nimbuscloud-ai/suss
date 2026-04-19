// UserCard has two branches in its inferred render:
//   - `if (!user) return null;`  (early-return, null-user path)
//   - default: `<div>{user.name}</div>` (render path)
//
// Only a "Loaded" story is provided here — no story passes `user:
// null`, so the null-user branch has no declared scenario exercising
// it. The component-story agreement check should surface a
// `scenarioCoverageGap` finding for the `user` prop: there's a
// conditional branch on it that no story reaches.

import type { UserCard } from "../react/UserCard";

const meta = {
  component: UserCard,
};
export default meta;

export const Loaded = {
  args: {
    user: { id: "u1", name: "Matt" },
  },
};
