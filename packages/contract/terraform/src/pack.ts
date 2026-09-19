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
  /**
   * What the resource declares. The default, `"container"`, means the
   * resource is the thing code addresses: code passes a bucket's name
   * to `bucket()`, so the declared name and the accessed name meet.
   * `"store"` means the resource only says the store exists. Code
   * splits a Redis cluster into key namespaces, no attribute of the
   * cluster lists them, so the summary gets no container name and
   * claims no access. Any match on the cluster's own name would be a
   * coincidence between a deployment name and a key prefix.
   */
  declares?: "container" | "store";
  /** The attribute that says what the resource is called once deployed. */
  nameAttribute?: string;
  /**
   * The attribute naming the namespace a container belongs to. A
   * BigQuery table is always addressed through its dataset, so two
   * tables called `orders` in two datasets are two containers.
   */
  scopeAttribute?: string;
  /** Whether the fields it declares are every field an item has. */
  fieldSet: "exhaustive" | "partial" | "none";
  /** The attributes that state what identifies an item, in key order. */
  identifies?: string[];
  /** Blocks that declare another way in, each keyed on its own fields. */
  accessPathBlocks?: string[];
  /** The block that gives each field a type, and its two attributes. */
  fieldTypes?: { block: string; nameAttribute: string; typeAttribute: string };
  /**
   * An attribute stating every field as JSON, one object per field. A
   * schema written this way is every field the item has, so reading one
   * makes the contract exhaustive whatever `fieldSet` says.
   */
  fieldsFromJson?: {
    /** The attribute whose value is a JSON list of field objects. */
    attribute: string;
    /** The key of one entry that says what the field is called. */
    nameKey: string;
    /** The key of one entry that gives the field its type. */
    typeKey?: string;
    /** The key that says a field is always set, and the values that do. */
    requires?: { key: string; values: string[] };
  };
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

/**
 * How the deployed metric type is spelled, with each `{...}` standing
 * for the value at that attribute. A CloudWatch metric is identified by
 * its namespace and its name together, so a template says where both
 * come from: `"{metric_transformation.namespace}/{metric_transformation.name}"`.
 * A hole the resource leaves unset makes the whole identity unknown, so
 * the summary pairs with nothing rather than with a half-spelled name.
 */
export type MetricTypeTemplate = string;

/** A named series of measurements a resource declares. */
export interface MetricResource {
  kind: "metric";
  /** Which system the series lives in: cloud-monitoring. */
  metricSystem: string;
  /** How the string both sides spell is built from the resource. */
  metricTypeTemplate: MetricTypeTemplate;
  /** Which attribute says whether one measurement is a number or a histogram. */
  values?: AttributeMeaning<MetricValueShape>;
  /** Which attribute says what a measurement covers. */
  accumulates?: AttributeMeaning<MetricAccumulation>;
}

/**
 * How a reading says which metric it is about. A CloudWatch alarm
 * writes the namespace and the name in attributes of its own; a Cloud
 * Monitoring condition states a query, and the metric is one value
 * inside it.
 */
export type MetricIdentity =
  | { from: "attributes"; template: MetricTypeTemplate }
  | {
      from: "query";
      /** The attribute whose query says which metric this is about. */
      attribute: string;
      /** The key inside that query whose value is the metric's type. */
      key: string;
    };

/**
 * A resource that reads a metric another resource declares. One
 * resource usually states several readings, each in its own block and
 * each about its own metric, so each becomes a boundary of its own.
 */
export interface MetricReadingResource {
  kind: "metric-reading";
  metricSystem: string;
  /**
   * The blocks one reading is written inside, outermost first. An empty
   * list means the resource is itself one reading.
   */
  readingBlocks: string[];
  /** How the reading spells the metric it is about. */
  identifies: MetricIdentity;
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
   * An attribute that decides whether the entry describes the resource
   * at all. `aws_elasticache_cluster` deploys whichever engine its
   * `engine` attribute picks, and only some engines are the store the
   * entry describes. A value outside `equals`, or one built at deploy
   * time, means the resource is not read, rather than read as
   * something it may not be. `whenUnset` says what an absent attribute
   * means; the default is not to read the resource.
   */
  appliesWhen?: {
    attribute: string;
    /** The values that mean the entry describes this resource. */
    equals?: string[];
    /**
     * The prefixes that do, for an attribute stating an engine and a
     * release together: Cloud SQL writes `POSTGRES_15`.
     */
    startsWith?: string[];
    whenUnset?: "read" | "skip";
  };
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
