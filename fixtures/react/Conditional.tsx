// Exercises Phase 1.4 inline JSX conditional decomposition:
//   - `{isLoading && <Spinner/>}` → conditional(isLoading, <Spinner/>, null)
//   - `{error ? <Error/> : <Content/>}` → conditional(error, <Error/>, <Content/>)
//   - `{items.length > 0 ? <List/> : null}` → conditional(items.length > 0, <List/>, null)
//   - A plain JSX expression `{items.map(...)}` stays opaque as an
//     `expression` node — the conditional decomposition only applies
//     when at least one branch is statically JSX or null.

interface Props {
  isLoading: boolean;
  error: string | null;
  items: string[];
}

export default function Conditional({ isLoading, error, items }: Props) {
  return (
    <section>
      {isLoading && <span>loading...</span>}
      {error ? <div className="err">{error}</div> : <div>ok</div>}
      {items.length > 0 ? <ul>{items.map((i) => i)}</ul> : null}
    </section>
  );
}
