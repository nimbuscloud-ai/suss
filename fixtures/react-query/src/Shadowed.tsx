// A local function that has the hook's name. The pack leaves it alone.

function useQuery(options: unknown) {
  return options;
}

export function Shadowed() {
  const q = useQuery({ queryFn: () => [] });
  return <ul>{String(q)}</ul>;
}
