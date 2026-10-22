/**
 * One table read out of a dump of the database, and the storage summary
 * it becomes. Both dump formats end here, so a table reads the same
 * whichever of `db/schema.rb` and `db/structure.sql` the app keeps.
 */

import { storageBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  StorageContractMetadata,
} from "@suss/behavioral-ir";

export type ContractField = NonNullable<
  StorageContractMetadata["fields"]
>[number];

export interface DumpTable {
  /** `orders`, or `audit.events` for a table outside the default schema. */
  name: string;
  /** The lines the table is declared on, counting from one. */
  start: number;
  end: number;
  columns: ContractField[];
}

/** Where the summaries go, and the database they describe. */
export interface DumpPlacement {
  file: string;
  scope: string;
  /** Null when nothing says which engine the database runs. */
  storageSystem: string | null;
}

export function tableSummary(
  table: DumpTable,
  placement: DumpPlacement,
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: placement.file,
      range: { start: table.start, end: table.end },
      exportName: null,
    },
    identity: {
      name: table.name,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "rails-schema",
        storageSystem: placement.storageSystem,
        scope: placement.scope,
        container: table.name,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        // The dump lists every column the database has.
        fieldSet: "exhaustive",
        fields: table.columns,
        origin: "dump",
      },
    },
  };
}
