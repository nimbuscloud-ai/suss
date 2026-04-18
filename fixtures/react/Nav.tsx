// Component whose sole return is a JSX fragment. Exercises the
// fragment path of the jsxReturn matcher (`jsxRootName` maps fragments
// to `"Fragment"`).

export default function Nav() {
  return (
    <>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </>
  );
}
