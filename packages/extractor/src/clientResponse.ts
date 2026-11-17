/**
 * A TypeScript client pack's response members, as a request chain says
 * them. The pack lists each member with how a caller reads it, a property
 * or a method, which the TypeScript readers need, and its chain in
 * `@suss/recognize` lists the same members by what each one means, so
 * the pack writes them once and passes the chain this.
 */

import type {
  ClientResponse,
  PatternPack,
  ResponsePropertyMapping,
} from "./framework.js";

type ResponseMember = keyof Pick<
  ClientResponse,
  "statusCode" | "success" | "body" | "headers"
>;

/** The member a mapping is, by what it means. Only a range of 200 to 299 says the request succeeded. */
const MEMBER_OF: Record<
  ResponsePropertyMapping["semantics"]["type"],
  (mapping: ResponsePropertyMapping) => ResponseMember | null
> = {
  statusCode: () => "statusCode",
  statusRange: ({ semantics }) =>
    semantics.type === "statusRange" &&
    semantics.min === 200 &&
    semantics.max === 299
      ? "success"
      : null,
  body: () => "body",
  headers: () => "headers",
};

/** What a pack's response members and deliveries say, as a request chain's `response` takes them. */
export function clientResponseOf(
  pack: Pick<
    PatternPack,
    | "responseSemantics"
    | "failureDelivery"
    | "redirectDelivery"
    | "redirectOption"
  >,
): ClientResponse {
  const members: Partial<Record<ResponseMember, string[]>> = {};
  for (const mapping of pack.responseSemantics ?? []) {
    const member = MEMBER_OF[mapping.semantics.type](mapping);
    if (member !== null) {
      members[member] = [...(members[member] ?? []), mapping.name];
    }
  }
  return {
    ...members,
    ...(pack.failureDelivery === undefined
      ? {}
      : { failureDelivery: pack.failureDelivery }),
    ...(pack.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: pack.redirectDelivery }),
    ...(pack.redirectOption === undefined
      ? {}
      : { redirectOption: pack.redirectOption }),
  };
}
