// A component that casts its JSX on the way out.

export function Badge({ count }: { count: number }) {
  return (<span className="badge">{count}</span>) as JSX.Element;
}
