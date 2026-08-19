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

import type {
  MessageBusTechnology,
  MetricAccumulation,
  MetricValueShape,
} from "@suss/behavioral-ir";

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
  /**
   * How another way in says what it can serve. A DynamoDB index copies
   * some of an item rather than all of it, and a reader asking for
   * anything else gets nothing back and no error, so what it copies is
   * every field it has rather than the ones somebody wrote down.
   */
  serves?: {
    /** The attribute that says which kind of copy it keeps. */
    kindAttribute: string;
    /** The attribute listing what it copies, for the kind that lists. */
    fieldsAttribute: string;
    /** The value of `kindAttribute` that means it copies the item. */
    everything: string;
  };
}

/** A channel messages cross. */
export interface MessageBusResource {
  kind: "message-bus";
  messageBus: MessageBusTechnology;
  nameAttribute?: string;
}

/**
 * An attribute whose value the pack translates into one of suss's own
 * words. The reader takes the value at `attribute` and looks it up in
 * `means`; a value the pack did not list says nothing, the same as an
 * attribute the configuration never set.
 */
export interface AttributeMeaning<T extends string> {
  /** The attribute path whose value says which one it is. */
  attribute: string;
  /** What each value the provider can write there means. */
  means: Record<string, T>;
}

/** A named series of measurements a resource declares. */
export interface MetricResource {
  kind: "metric";
  /** Which system the series lives in: cloud-monitoring. */
  metricSystem: string;
  /** The attribute that says what the metric is called. */
  nameAttribute: string;
  /**
   * How the deployed metric type is spelled, with `{name}` standing
   * for the declared name. That string is what a resource reading the
   * metric spells, so it is the identity the two sides share.
   */
  metricTypeTemplate: string;
  /** Which attribute says whether one measurement is a number or a histogram. */
  values?: AttributeMeaning<MetricValueShape>;
  /** Which attribute says what a measurement covers. */
  accumulates?: AttributeMeaning<MetricAccumulation>;
}

/**
 * A resource that reads a metric another resource declares. One
 * resource usually states several readings, each in its own block and
 * each about its own metric, so each becomes a boundary of its own.
 */
export interface MetricReadingResource {
  kind: "metric-reading";
  metricSystem: string;
  /** The blocks one reading is written inside, outermost first. */
  readingBlocks: string[];
  /** The attribute whose query says which metric the reading is about. */
  queryAttribute: string;
  /** The key inside that query whose value is the metric's type. */
  queryIdentityKey: string;
  /**
   * The attribute whose presence means the reading compares the series
   * against a value of this shape. A condition states a threshold, so
   * the number it compares against is the attribute being set at all.
   */
  comparesTo?: { attribute: string; whenSet: MetricValueShape };
  /** Which attribute says what the reading reduces each window to first. */
  reducesTo?: AttributeMeaning<MetricValueShape>;
}

export type TerraformResource =
  | StorageResource
  | MessageBusResource
  | MetricResource
  | MetricReadingResource;

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
