import { useQuery } from "@apollo/client";

import { graphql } from "../gql/gql";

const ListingCardQuery = graphql(`
  query ListingCard($id: ID!) {
    listing(id: $id) {
      id
      title
      shortDesc
    }
  }
`);

export function ListingCard({ id }: { id: string }) {
  const { data, loading } = useQuery(ListingCardQuery, { variables: { id } });
  if (loading) {
    return <p>Loading</p>;
  }
  return (
    <article>
      <h2>{data?.listing?.title}</h2>
      <p>{data?.listing?.shortDesc}</p>
    </article>
  );
}
