/**
 * The types a Terraform pack uses to describe the resources one provider
 * declares.
 *
 * A provider defines its own resource types, and each version defines
 * their attributes, so both belong in a pack and stay out of this
 * reader. The reader walks HCL and matches resources. A pack describes
 * what `aws_dynamodb_table` is and which provider versions that covers.
 *
 * Every entry is data. When these types cannot describe a resource,
 * widen them, so a pack never ships code the reader cannot inspect.
 */

import type {
  DeployableUnit,
  MessageBusTechnology,
  MetricAccumulation,
  MetricValueShape,
} from "@suss/behavioral-ir";

/**
 * An attribute whose value the pack translates into suss's own terms.
 * The reader looks up the value at `attribute` in `means`. A value the
 * pack did not list, or one the configuration builds at deploy time,
 * maps to nothing.
 */
export interface AttributeMeaning<T extends string> {
  /** The attribute path to read. */
  attribute: string;
  /** The suss term for each value the provider can write there. */
  means: Record<string, T>;
  /**
   * Whether a value has to equal a key of `means` or start with one.
   * Cloud SQL writes an engine and a release together, `POSTGRES_15`,
   * and the releases change every quarter, so a pack lists the prefix.
   */
  matches?: "value" | "prefix";
  /** The meaning to use when the resource does not set the attribute. */
  whenUnset?: T;
}

/** A store a caller addresses by container and key. */
export interface StorageResource {
  kind: "storage";
  /**
   * The store, such as `aws.dynamodb` or `s3`. A resource whose engine
   * depends on one of its attributes gives an AttributeMeaning instead.
   * A value the pack does not list leaves the store with no engine, and
   * the resource is still read.
   */
  storageSystem: string | AttributeMeaning<string>;
  /** How a caller reaches it, when that differs from the store's own name. */
  transport?: string;
  /**
   * What the resource declares. The default, `"container"`, means code
   * addresses the resource directly: code passes a bucket's name to
   * `bucket()`, so the declared name matches the accessed one. `"store"`
   * means the resource only declares that the store exists. Code splits
   * a Redis cluster into key namespaces that no attribute of the cluster
   * lists, so the summary gets no container name and claims no access.
   * A match on the cluster's own name would be a coincidence between a
   * deployment name and a key prefix.
   */
  declares?: "container" | "store";
  /** The attribute that contains the resource's deployed name. */
  nameAttribute?: string;
  /**
   * The attribute that contains the namespace a container belongs to. A
   * BigQuery table is always addressed through its dataset, so two
   * tables called `orders` in two datasets are two containers.
   */
  scopeAttribute?: string;
  /** Whether the fields it declares are every field an item has. */
  fieldSet: "exhaustive" | "partial" | "none";
  /** The attributes that list an item's key fields, in key order. */
  identifies?: string[];
  /** Blocks that declare another access path, each keyed on its own fields. */
  accessPathBlocks?: string[];
  /** The block that gives each field a type, and its two attributes. */
  fieldTypes?: { block: string; nameAttribute: string; typeAttribute: string };
  /**
   * An attribute that lists every field as JSON, one object per field. A
   * schema written this way lists every field the item has, so reading
   * one makes the contract exhaustive regardless of `fieldSet`.
   */
  fieldsFromJson?: {
    /** The attribute whose value is a JSON list of field objects. */
    attribute: string;
    /** The key in each entry that contains the field's name. */
    nameKey: string;
    /** The key in each entry that contains the field's type. */
    typeKey?: string;
    /** The key that marks a field as always set, and the values that do. */
    requires?: { key: string; values: string[] };
  };
  /**
   * Which fields an access path can return. A DynamoDB index copies only
   * part of an item, and a read of any other attribute returns nothing
   * without an error, so the copied attributes are the index's complete
   * field list.
   */
  serves?: {
    /** The attribute that contains the projection kind. */
    kindAttribute: string;
    /** The attribute listing the copied fields, for a kind that lists them. */
    fieldsAttribute: string;
    /** The `kindAttribute` value that means the whole item is copied. */
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
 * The pattern of the deployed metric type, where each `{...}` is
 * replaced by the value at that attribute path. A CloudWatch metric is
 * identified by its namespace and its name together, so its template
 * gives both: `"{metric_transformation.namespace}/{metric_transformation.name}"`.
 * When the resource leaves one of those attributes unset, the whole
 * identity is unknown, so the summary does not pair on a partial name.
 */
export type MetricTypeTemplate = string;

/** A named series of measurements a resource declares. */
export interface MetricResource {
  kind: "metric";
  /** The metrics system, such as `cloud-monitoring`. */
  metricSystem: string;
  /** How the identity both sides write is built from the resource. */
  metricTypeTemplate: MetricTypeTemplate;
  /** The attribute that decides whether a measurement is a number or a histogram. */
  values?: AttributeMeaning<MetricValueShape>;
  /** The attribute that decides what one measurement covers. */
  accumulates?: AttributeMeaning<MetricAccumulation>;
}

/**
 * Where a reading gives the metric it is about. A CloudWatch alarm
 * writes the namespace and the name as attributes. A Cloud Monitoring
 * condition writes a query, and the metric is one value inside it.
 */
export type MetricIdentity =
  | { from: "attributes"; template: MetricTypeTemplate }
  | {
      from: "query";
      /** The attribute that contains the query. */
      attribute: string;
      /** The key inside that query whose value is the metric's type. */
      key: string;
    };

/**
 * A resource that reads a metric another resource declares. One
 * resource often contains several readings, each in its own block and
 * about its own metric, so each becomes its own boundary.
 */
export interface MetricReadingResource {
  kind: "metric-reading";
  metricSystem: string;
  /**
   * The blocks one reading is written inside, outermost first. An empty
   * list means the resource is itself one reading.
   */
  readingBlocks: string[];
  /** Where the reading gives the metric it is about. */
  identifies: MetricIdentity;
  /**
   * An attribute whose presence means the reading compares the series
   * against a value of this shape. A condition that sets a threshold
   * compares against a number, whatever the number is.
   */
  comparesTo?: { attribute: string; whenSet: MetricValueShape };
  /** The attribute that decides what the reading reduces each window to. */
  reducesTo?: AttributeMeaning<MetricValueShape>;
}

/**
 * Where a provider writes one process's environment: either a map
 * attribute keyed by variable name, or repeated entries that each give
 * one variable's name and its source, a literal or a secret.
 */
export type EnvDeclaration =
  | { style: "map"; attribute: string }
  | {
      style: "entries";
      /** The block one entry is written as, as a dotted path. */
      block: string;
      /** The attribute that contains the variable's name. */
      nameAttribute: string;
      /** The attribute that contains the value, for an entry that writes one. */
      valueAttribute?: string;
      /** The attribute that contains the secret supplying the value. */
      secretAttribute?: string;
    };

/**
 * How a platform writes the handler it calls. `"module.export"` is a
 * module path and an exported name joined at the last dot, as Lambda
 * takes it. `"name"` is an exported name alone, with no file.
 */
export type HandlerSpelling = "module.export" | "name";

/** Where the provider records the code one process runs. */
export interface DeployableCode {
  /** The attribute that contains the function the platform calls. */
  handler?: { attribute: string; spelling: HandlerSpelling };
  /** The attribute that contains the image a container runs. */
  imageAttribute?: string;
}

/** A resource that deploys several processes, each with its own environment. */
export interface DeployableContainers {
  /** The blocks one container is written inside, outermost first. */
  blocks: string[];
  /** The attribute inside a container that contains its name. */
  nameAttribute?: string;
}

/**
 * Something that gets deployed and runs, such as a function, a
 * container or a job. It declares the environment the process starts
 * with, so suss can report code that reads a variable the deployment
 * never sets.
 *
 * The unit is keyed by the resource's label, and the deployed name is
 * not used. The rest of the configuration refers to the resource by its
 * label, as CloudFormation does with a logical id, and a variable that
 * points at the resource resolves to it.
 */
export interface DeployableResource {
  kind: "deployable";
  /** What runs it, as a deployable unit's `deploymentTarget`. */
  deploymentTarget: DeployableUnit["deploymentTarget"];
  /** Where each process is written, for a resource that deploys several. */
  containers?: DeployableContainers;
  /** Where the environment is written, inside the process. */
  env?: EnvDeclaration[];
  /** Where the provider records the code the process runs. */
  code?: DeployableCode;
  /** The attribute that contains the language runtime, copied as written. */
  runtimeAttribute?: string;
  /**
   * Variables the platform sets regardless of the configuration. An
   * entry that leaves this out gets the list for its deployment target,
   * which every other reader of that target uses. A product with its own
   * list, such as Cloud Run, sets it here.
   */
  platformEnvVars?: readonly string[];
}

export type TerraformResource =
  | StorageResource
  | MessageBusResource
  | MetricResource
  | MetricReadingResource
  | DeployableResource;

/** One resource type, as one version range of one provider declares it. */
export interface TerraformResourcePattern {
  /** The resource type, as the provider writes it. */
  resource: string;
  /**
   * An attribute that decides whether the entry describes the resource
   * at all. A Firestore database in Datastore mode uses a different
   * API, so the Firestore entry does not describe it. A value outside
   * `equals`, or one built at deploy time, means the resource is
   * skipped, so it is never read as something it may not be.
   * `whenUnset` gives what an absent attribute means; by default the
   * resource is skipped.
   */
  appliesWhen?: {
    attribute: string;
    /** The values that mean the entry describes this resource. */
    equals?: string[];
    whenUnset?: "read" | "skip";
  };
  /**
   * Which provider versions this describes, as a semver range. A
   * configuration states its own constraint under `required_providers`,
   * and an entry outside it is not read. A configuration that states no
   * constraint is read by every entry, since nothing rules any out.
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
