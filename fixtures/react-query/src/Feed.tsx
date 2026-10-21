// The infinite and suspense hooks, and a query function written as a
// method of the options object.

import {
  useInfiniteQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";

import { api } from "./api";

export function Feed() {
  const pages = useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: ({ pageParam }: { pageParam: number }) => api.fetchPage(pageParam),
    initialPageParam: 0,
  });
  const totals = useSuspenseQuery({
    queryKey: ["totals"],
    queryFn() {
      return fetch("/api/totals").then((response) => response.json());
    },
  });
  const archive = useSuspenseInfiniteQuery({
    queryKey: ["archive"],
    queryFn: async () => {
      const response = await fetch("/api/archive");
      return response.json();
    },
  });
  return (
    <div>
      {String(pages)}
      {String(totals)}
      {String(archive)}
    </div>
  );
}
