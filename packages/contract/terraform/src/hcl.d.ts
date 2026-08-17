/**
 * `hcl2-parser` ships no types. It exposes one function, which reads an
 * HCL document and gives back what it read and what stopped it.
 */
declare module "hcl2-parser" {
  const hcl2: { parseToObject(source: string): [unknown, unknown] };
  export default hcl2;
}
