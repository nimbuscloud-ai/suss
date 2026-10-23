import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client";

export const railsClient = new ApolloClient({
  uri: "/graphql",
  cache: new InMemoryCache(),
});

export const appSyncClient = new ApolloClient({
  link: new HttpLink({ uri: "https://events.appsync-api.example.com/graphql" }),
  cache: new InMemoryCache(),
});
