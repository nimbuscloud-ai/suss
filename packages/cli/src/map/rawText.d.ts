// The map's stylesheet and browser script are imported as text so the
// build puts them inside the page. Vitest reads `?raw` itself, and the
// build's esbuild plugin does the same.
declare module "*?raw" {
  const text: string;
  export default text;
}
