import type { Seed } from "./seed.js";

/** The files of one program, by path. The unit is always in `/app/index.ts`. */
export type Program = Readonly<Record<string, string>>;

/**
 * One way of writing the seed's program that the language guarantees does
 * the same thing. The name is what a failure prints, so it says which
 * indirection was lost rather than which line moved.
 */
export interface Rewrite {
  readonly name: string;
  readonly program: (seed: Seed) => Program;
}

/** The program every rewrite has to agree with: the call written in the unit. */
export function seedProgram(seed: Seed): Program {
  return {
    "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};

export async function handler(event: { id: string }) {
  return ${seed.access("client", "event.id")};
}
`,
  };
}

/** A class taking its client as a parameter property, which three rewrites reach differently. */
function daoModule(seed: Seed): string {
  return `
${seed.importLine}

export interface Reader {
  load(id: string): Promise<unknown>;
}

export class Dao implements Reader {
  constructor(private readonly client: ${seed.clientType}) {}

  async load(id: string) {
    return ${seed.access("this.client", "id")};
  }
}
`;
}

/** A module performing the call, for the rewrites that vary how it is reached. */
function accessModule(seed: Seed): string {
  return `
${seed.importLine}

const client = ${seed.newClient};

export async function load(id: string) {
  return ${seed.access("client", "id")};
}
`;
}

function entryCalling(body: string, imports = ""): string {
  return `${imports}
export async function handler(event: { id: string }) {
${body}
}
`;
}

export const REWRITES: readonly Rewrite[] = [
  {
    name: "the call moved into a helper the unit calls",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};

async function load(id: string) {
  return ${seed.access("client", "id")};
}

export async function handler(event: { id: string }) {
  return load(event.id);
}
`,
    }),
  },
  {
    name: "the client held in a local",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

export async function handler(event: { id: string }) {
  const client = ${seed.newClient};
  return ${seed.access("client", "event.id")};
}
`,
    }),
  },
  {
    name: "the client held in a field the constructor body sets",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

class Store {
  private readonly client: ${seed.clientType};

  constructor() {
    this.client = ${seed.newClient};
  }

  async load(id: string) {
    return ${seed.access("this.client", "id")};
  }
}

const store = new Store();

export async function handler(event: { id: string }) {
  return store.load(event.id);
}
`,
    }),
  },
  {
    name: "the field set from a constructor parameter",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

class Store {
  private readonly client: ${seed.clientType};

  constructor(client: ${seed.clientType}) {
    this.client = client;
  }

  async load(id: string) {
    return ${seed.access("this.client", "id")};
  }
}

const store = new Store(${seed.newClient});

export async function handler(event: { id: string }) {
  return store.load(event.id);
}
`,
    }),
  },
  {
    name: "the field set from a parameter property",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

class Store {
  constructor(private readonly client: ${seed.clientType}) {}

  async load(id: string) {
    return ${seed.access("this.client", "id")};
  }
}

const store = new Store(${seed.newClient});

export async function handler(event: { id: string }) {
  return store.load(event.id);
}
`,
    }),
  },
  {
    name: "the dependency constructed by the caller and passed in",
    program: (seed) => ({
      "/app/dao.ts": daoModule(seed),
      "/app/service.ts": `
import type { Reader } from "./dao.js";

export class Service {
  constructor(private readonly reader: Reader) {}

  async run(id: string) {
    return this.reader.load(id);
  }
}
`,
      "/app/index.ts": `
${seed.importLine}
import { Dao } from "./dao.js";
import { Service } from "./service.js";

const service = new Service(new Dao(${seed.newClient}));

export async function handler(event: { id: string }) {
  return service.run(event.id);
}
`,
    }),
  },
  {
    name: "the dependency built by a factory function",
    program: (seed) => ({
      "/app/dao.ts": daoModule(seed),
      "/app/factory.ts": `
${seed.importLine}
import { Dao } from "./dao.js";

import type { Reader } from "./dao.js";

export function makeDao(): Reader {
  return new Dao(${seed.newClient});
}
`,
      "/app/index.ts": `
import { makeDao } from "./factory.js";

const dao = makeDao();

export async function handler(event: { id: string }) {
  return dao.load(event.id);
}
`,
    }),
  },
  {
    name: "the dependency built by a factory returning a factory",
    program: (seed) => ({
      "/app/dao.ts": daoModule(seed),
      "/app/factory.ts": `
${seed.importLine}
import { Dao } from "./dao.js";

import type { Reader } from "./dao.js";

export function daoBuilder(): () => Reader {
  return () => new Dao(${seed.newClient});
}
`,
      "/app/index.ts": `
import { daoBuilder } from "./factory.js";

const dao = daoBuilder()();

export async function handler(event: { id: string }) {
  return dao.load(event.id);
}
`,
    }),
  },
  {
    name: "the module reached through a barrel re-export",
    program: (seed) => ({
      "/app/access/load.ts": accessModule(seed),
      "/app/access/index.ts": `export { load } from "./load.js";\n`,
      "/app/index.ts": entryCalling(
        "  return load(event.id);",
        `import { load } from "./access/index.js";\n`,
      ),
    }),
  },
  {
    name: "the module reached through two barrels",
    program: (seed) => ({
      "/app/access/inner/load.ts": accessModule(seed),
      "/app/access/inner/index.ts": `export { load } from "./load.js";\n`,
      "/app/access/index.ts": `export { load } from "./inner/index.js";\n`,
      "/app/index.ts": entryCalling(
        "  return load(event.id);",
        `import { load } from "./access/index.js";\n`,
      ),
    }),
  },
  {
    name: "the call inside a method on an exported class",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};

export class Store {
  async load(id: string) {
    return ${seed.access("client", "id")};
  }
}

export async function handler(event: { id: string }) {
  return new Store().load(event.id);
}
`,
    }),
  },
  {
    name: "the call inside a map callback",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};

export async function handler(event: { id: string }) {
  const found = await Promise.all(
    [event.id].map((id) => ${seed.access("client", "id")}),
  );
  return found[0];
}
`,
    }),
  },
  {
    name: "the call inside a then callback",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};

export async function handler(event: { id: string }) {
  return Promise.resolve(event.id).then((id) => ${seed.access("client", "id")});
}
`,
    }),
  },
  {
    name: "the call inside a promise executor",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};

export async function handler(event: { id: string }) {
  return new Promise((resolve) => {
    resolve(${seed.access("client", "event.id")});
  });
}
`,
    }),
  },
  {
    name: "the call behind a conditional that always runs",
    program: (seed) => ({
      "/app/index.ts": `
${seed.importLine}

const client = ${seed.newClient};
const enabled = true;

export async function handler(event: { id: string }) {
  if (enabled) {
    return ${seed.access("client", "event.id")};
  }
  return null;
}
`,
    }),
  },
];
