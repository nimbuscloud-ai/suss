// identityKeys.ts: the minted identity-key formats, typed so a wrong
// literal refuses to compile. The mint is the only constructor, which
// is how a dropped prefix stops shipping again (#155, #167).

declare const IdentityKeyBrand: unique symbol;

/** `gql:Type.field`, the boundary key both GraphQL sides pair on. */
export type GqlIdentityKey = `gql:${string}.${string}` & {
  readonly [IdentityKeyBrand]: "gql";
};

export function gqlIdentityKey(
  typeName: string,
  fieldName: string,
): GqlIdentityKey {
  return `gql:${typeName}.${fieldName}` as GqlIdentityKey;
}
