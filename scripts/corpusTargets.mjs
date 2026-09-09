// corpusTargets.mjs - the public dogfood corpora, one place, so the
// profiler, the corpus gate, and the workflow that clones the repos
// cannot drift apart. Pins move only by editing this file.

/** Repositories the targets live in, cloned at the pinned commit. */
export const CORPUS_REPOS = {
  twenty: {
    url: "https://github.com/twentyhq/twenty.git",
    pin: "0288021c9c0f76f0424e327dce984d1657271ef8",
  },
  "saleor-dashboard": {
    url: "https://github.com/saleor/saleor-dashboard.git",
    pin: "0601672580f24b4a6353316d67605dabfe75bf99",
  },
  "saleor-storefront": {
    url: "https://github.com/saleor/storefront.git",
    pin: "8de1ae7320b97a012ade6d88001af49bfe32bfb4",
  },
  directus: {
    url: "https://github.com/directus/directus.git",
    pin: "193a65a807a4b7557c7705e54b975eb0e1c53ecf",
  },
};

/**
 * One run per target: the directory `suss init` is pointed at.
 *
 * Which packs to load, which config files to write and which commands
 * to run all come out of init, so a target says where the project is
 * and nothing else. A pack list written here would be a third copy of
 * what a project needs, and never the path anybody takes.
 */
export const CORPUS_TARGETS = {
  "twenty-server": {
    repo: "twenty",
    directory: "twenty/packages/twenty-server",
  },
  "twenty-front": {
    repo: "twenty",
    directory: "twenty/packages/twenty-front",
  },
  "saleor-dashboard": {
    repo: "saleor-dashboard",
    directory: "saleor-dashboard",
  },
  "saleor-storefront": {
    repo: "saleor-storefront",
    directory: "saleor-storefront",
  },
  "directus-api": {
    repo: "directus",
    directory: "directus/api",
  },
};
