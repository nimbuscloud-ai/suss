// Apollo Server v4 code-first fixture. Exercises:
//   - Query.<field> resolver returning a value
//   - Query.<field> with a conditional branch (args narrowing)
//   - Mutation.<field> resolver that throws on missing auth
//   - User.<field> resolver (type-level, not Query/Mutation)
//   - A resolver defined via method shorthand vs arrow function
//
// Type annotations are loose on purpose — the pack discovers by
// structural position on the resolver map, not by type.

import { ApolloServer } from "@apollo/server";

const typeDefs = `
  type User { id: ID!  firstName: String!  lastName: String!  fullName: String! }
  type Query { users: [User!]!  user(id: ID!): User }
  type Mutation { createUser(firstName: String!, lastName: String!): User! }
`;

interface Ctx {
  viewerId: string | null;
  db: {
    users: { findAll: () => Promise<unknown> };
  };
}

const resolvers = {
  Query: {
    // Arrow-function form.
    users: async (_parent: unknown, _args: unknown, ctx: Ctx) => {
      return ctx.db.users.findAll();
    },
    // Conditional branch on args — used by coverage-gap style checks.
    user: async (_parent: unknown, args: { id: string }, ctx: Ctx) => {
      if (args.id === "") {
        throw new Error("id is required");
      }
      return { id: args.id };
    },
  },
  Mutation: {
    // Method-shorthand form + an explicit throw branch.
    async createUser(
      _parent: unknown,
      args: { firstName: string; lastName: string },
      ctx: Ctx,
    ) {
      if (ctx.viewerId === null) {
        throw new Error("unauthenticated");
      }
      return { id: "new", firstName: args.firstName, lastName: args.lastName };
    },
  },
  User: {
    // Type-level resolver — `parent` is the resolved User object.
    fullName: (parent: { firstName: string; lastName: string }) => {
      return `${parent.firstName} ${parent.lastName}`;
    },
  },
};

export const server = new ApolloServer({ typeDefs, resolvers });
