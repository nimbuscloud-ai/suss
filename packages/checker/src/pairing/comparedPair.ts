/**
 * One pair of summaries that a pass compared.
 *
 * Each protocol has its own pass. If the report counted only the pairs
 * that method-and-path pairing matched, a run over stores or queues
 * would say nothing was compared. So every pass records its pairs in
 * this form, and the caller counts them and removes them from the
 * unpaired lists.
 *
 * `provider` and `consumer` are summary ids. Two files can each export
 * `update`, and a bare name would not tell them apart or give a reader
 * a file to open.
 */
export interface ComparedPair {
  /** The boundary key, written the way the pass that paired them writes it. */
  key: string;
  provider: string;
  consumer: string;
}
