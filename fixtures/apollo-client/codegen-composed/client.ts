import { ApolloClient, InMemoryCache } from "@apollo/client";

export const apolloClient = new ApolloClient({
  uri: "https://shop.example.com/graphql/",
  cache: new InMemoryCache({ typePolicies: {} }),
});
