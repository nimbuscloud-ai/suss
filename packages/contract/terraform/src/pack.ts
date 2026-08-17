/**
 * What a pack says about the resources one Terraform provider declares.
 *
 * A provider states its own resource types, and a version of it states
 * their shape, so both belong to a pack rather than to this reader. The
 * reader walks HCL and matches; a pack says what `aws_dynamodb_table`
 * is and which provider versions it is describing.
 *
 * Every entry is data rather than a function. A resource this shape
 * cannot describe is a reason to widen it, rather than a reason for a
 * pack to ship code the reader cannot see into.
 */

import type { MessageBusTechnology } from "@suss/behavioral-ir";

/** A store a caller addresses by container and key. */
export interface StorageResource {
  kind: "storage";
  /** Which store this is: dynamodb, s3. */
  storageSystem: string;
  /** How a caller reaches it, when that is not the store's own name. */
  transport?: string;
  /** The attribute that says what the resource is called once deployed. */
  nameAttribute?: string;
  /** Whether the fields it declares are every field an item has. */
  fieldSet: "exhaustive" | "partial" | "none";
  /** The attributes that state what identifies an item, in key order. */
  identifies?: string[];
  /** Blocks that declare another way in, each keyed on its own fields. */
  accessPathBlocks?: string[];
  /** The block that gives each field a type, and its two attributes. */
  fieldTypes?: { block: string; nameAttribute: string; typeAttribute: string };
}

/** A channel messages cross. */
export interface MessageBusResource {
  kind: "message-bus";
  messageBus: MessageBusTechnology;
  nameAttribute?: string;
}

export type TerraformResource = StorageResource | MessageBusResource;

/** One resource type, as one version range of one provider declares it. */
export interface TerraformResourcePattern {
  /** The resource type, spelled the way the provider spells it. */
  resource: string;
  /**
   * Which provider versions this describes, as a semver range. A
   * configuration states its own constraint under `required_providers`,
   * and an entry outside it is not read. A configuration that states no
   * constraint is read by every entry, since nothing said otherwise.
   */
  providerVersions: string;
  /** What the resource is, once read. */
  boundary: TerraformResource;
}

export interface TerraformPack {
  /** The pack's own name, for messages. */
  name: string;
  /**
   * The provider these resources come from, as `required_providers`
   * keys it: `aws`, `google`, `cloudflare`.
   */
  provider: string;
  resources: TerraformResourcePattern[];
}
