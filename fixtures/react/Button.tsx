// Component that returns a self-closing JSX element, in parenthesized
// form — covers both `JsxSelfClosingElement` and the parenthesized
// unwrap path in the adapter's `jsxRootName`.

export default function Button({ label }: { label: string }) {
  return <button type="button">{label}</button>;
}
