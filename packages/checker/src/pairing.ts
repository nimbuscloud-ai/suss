import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a route path to a canonical form for matching.
 *
 * - Converts Express-style params (`:id`) to brace-style (`{id}`)
 * - Strips trailing slashes (except bare `/`)
 * - Lowercases the static segments (params stay case-sensitive)
 */
export function normalizePath(path: string): string {
  // :param → {param}
  let normalized = path.replace(/:([a-zA-Z_]\w*)/g, "{$1}");

  // Strip trailing slash (keep bare /)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Lowercase static segments, preserve param names inside braces
  normalized = normalized.replace(/\{[^}]+\}|[^{]+/g, (segment) =>
    segment.startsWith("{") ? segment : segment.toLowerCase(),
  );

  return normalized;
}

// ---------------------------------------------------------------------------
// Boundary key
// ---------------------------------------------------------------------------

/**
 * Compute a stable string key from a boundary binding for grouping.
 * Returns null when the binding has no path (can't be paired automatically).
 */
export function boundaryKey(binding: BoundaryBinding): string | null {
  if (binding.path === undefined) {
    return null;
  }

  const method = (binding.method ?? "ANY").toUpperCase();
  const path = normalizePath(binding.path);

  return `${method} ${path}`;
}

// ---------------------------------------------------------------------------
// Provider / client classification
// ---------------------------------------------------------------------------

const PROVIDER_KINDS = new Set([
  "handler",
  "loader",
  "action",
  "middleware",
  "resolver",
]);

const CLIENT_KINDS = new Set(["client", "consumer"]);

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface SummaryPair {
  provider: BehavioralSummary;
  consumer: BehavioralSummary;
  key: string;
}

export interface PairingResult {
  pairs: SummaryPair[];
  unmatched: {
    providers: BehavioralSummary[];
    consumers: BehavioralSummary[];
    noBinding: BehavioralSummary[];
  };
}

/**
 * Given a flat list of summaries, match providers to consumers by
 * `(method, normalizedPath)`.
 *
 * Each provider is paired with every matching consumer (N×M within a group).
 * Summaries without a boundary path end up in `unmatched.noBinding`.
 * Summaries with a path but no counterpart end up in the appropriate
 * `unmatched` bucket.
 */
export function pairSummaries(summaries: BehavioralSummary[]): PairingResult {
  const providersByKey = new Map<string, BehavioralSummary[]>();
  const consumersByKey = new Map<string, BehavioralSummary[]>();
  const noBinding: BehavioralSummary[] = [];

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      noBinding.push(summary);
      continue;
    }

    const key = boundaryKey(binding);
    if (key === null) {
      noBinding.push(summary);
      continue;
    }

    if (PROVIDER_KINDS.has(summary.kind)) {
      const list = providersByKey.get(key);
      if (list !== undefined) {
        list.push(summary);
      } else {
        providersByKey.set(key, [summary]);
      }
    } else if (CLIENT_KINDS.has(summary.kind)) {
      const list = consumersByKey.get(key);
      if (list !== undefined) {
        list.push(summary);
      } else {
        consumersByKey.set(key, [summary]);
      }
    } else {
      // Unknown kind — treat as no binding
      noBinding.push(summary);
    }
  }

  const pairs: SummaryPair[] = [];
  const matchedProviderKeys = new Set<string>();
  const matchedConsumerKeys = new Set<string>();

  for (const [key, providers] of providersByKey) {
    const consumers = consumersByKey.get(key);
    if (consumers === undefined) {
      continue;
    }

    matchedProviderKeys.add(key);
    matchedConsumerKeys.add(key);

    for (const provider of providers) {
      for (const consumer of consumers) {
        pairs.push({ provider, consumer, key });
      }
    }
  }

  const unmatchedProviders: BehavioralSummary[] = [];
  for (const [key, providers] of providersByKey) {
    if (!matchedProviderKeys.has(key)) {
      unmatchedProviders.push(...providers);
    }
  }

  const unmatchedConsumers: BehavioralSummary[] = [];
  for (const [key, consumers] of consumersByKey) {
    if (!matchedConsumerKeys.has(key)) {
      unmatchedConsumers.push(...consumers);
    }
  }

  return {
    pairs,
    unmatched: {
      providers: unmatchedProviders,
      consumers: unmatchedConsumers,
      noBinding,
    },
  };
}
