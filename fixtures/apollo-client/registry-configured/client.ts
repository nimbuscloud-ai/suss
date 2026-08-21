import { ApolloClient, gql, InMemoryCache } from "@apollo/client";
import { createFragmentRegistry } from "@apollo/client/cache";

// The registry supplies the Invoice definition at run time, so the
// dangling spread in queries.ts is not a throw.
export const apolloClient = new ApolloClient({
  uri: "https://shop.example.com/graphql/",
  cache: new InMemoryCache({
    fragments: createFragmentRegistry(gql`
      fragment Invoice on Invoice {
        id
        number
        createdAt
        url
        status
      }
    `),
  }),
});
