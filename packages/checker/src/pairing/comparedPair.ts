/**
 * What a pass compared, in the one spelling every pass uses.
 *
 * Each protocol has its own pass, and a report that counted only the
 * boundaries the method-and-path pairing matched said nothing was
 * compared on a run whose whole point was the stores or the queues. So
 * every pass records what it looked at here, and the caller both counts
 * these and subtracts them from the unpaired lists.
 *
 * `provider` and `consumer` are summary ids. Two files can each export
 * `update`, so a name on its own neither tells the two apart nor gives
 * the reader somewhere to go.
 */
export interface ComparedPair {
  /** The boundary the two sides met on, spelled by the owning pass. */
  key: string;
  provider: string;
  consumer: string;
}
