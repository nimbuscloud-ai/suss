/**
 * byteCheckInputs.mjs: what `npm run byte-check` extracts with each build.
 *
 * Every directory under fixtures/ has at least one input here, with the
 * packs and options its tests use, and the harness refuses to run when a
 * fixture is missing. A test that builds its pack in memory gets the
 * closest CLI form. Arguments are relative to the input's base: this
 * checkout for a fixture, the main build's checkout for a suss package,
 * and the clone for a field app. `withConfig` writes a pack's options to
 * a file and passes `-f pack=<file>` in its place. The CLI reads a path
 * inside a config file against the file's own directory, so a path
 * option is written as `inBase(p)` and made absolute.
 */

/** A path inside a pack config, resolved against the input's base. */
export function inBase(relative) {
  return { inBase: relative };
}

/** A pack whose options the harness writes to a config file. */
export function withConfig(pack, options) {
  return { pack, options };
}

const POSTGRES = { storageSystem: "postgresql" };

function dir(location) {
  return ["--dir", location];
}

function project(tsconfig) {
  return ["-p", tsconfig];
}

function lang(language) {
  return ["--lang", language];
}

function packs(...specs) {
  return specs.flatMap((spec) => ["-f", spec]);
}

/** An input named after its fixture, or after a project inside it. */
function fixture(name, args, more = {}) {
  return { name: `fixtures/${name}`, group: "fixtures", args, ...more };
}

function contract(name, from, spec) {
  return fixture(name, ["--from", from, spec], { command: "contract" });
}

const COMPAT_CASES = [
  "ts-esm",
  "js-esm",
  "cjs",
  "extended-tsconfig",
  "bundler",
  "path-alias",
  "separate-dts",
  "untyped-external",
];

const PYTHON_SOURCE_ROOTS = [
  "hatch",
  "plain-src",
  "poetry",
  "setuptools-find",
  "setuptools-package-dir",
  "unreadable-toml",
];

// The typed path needs the generated client. Generating writes into
// node_modules/.prisma and a gitignored folder, outside the tracked tree.
function prismaGenerate(schema) {
  return ["npx", "prisma", "generate", `--schema=${schema}`, "--no-hints"];
}

/** The rails pack, over a Rails layout's app/ and config/routes.rb. */
function railsIn(root) {
  return withConfig("rails", {
    root: inBase(`${root}/app`),
    routesFile: inBase(`${root}/config/routes.rb`),
  });
}

export const FIXTURE_INPUTS = [
  fixture("apollo", [...dir("fixtures/apollo"), ...packs("apollo")]),
  fixture("apollo-client", [
    ...dir("fixtures/apollo-client"),
    ...packs("apollo-client"),
  ]),
  ...[
    "dangling-fragment",
    "registry-configured",
    "codegen-composed",
    "wrapped-hooks",
  ].map((sub) =>
    fixture(`apollo-client/${sub}`, [
      ...dir(`fixtures/apollo-client/${sub}`),
      ...packs("apollo-client"),
    ]),
  ),
  contract("appsync", "appsync", "fixtures/appsync/petstore.yaml"),
  ...["external-schema", "list-form", "serverless"].map((sub) =>
    contract(
      `appsync/${sub}`,
      "appsync",
      `fixtures/appsync/${sub}/template.yaml`,
    ),
  ),
  fixture("aws-alb", [
    ...project("fixtures/aws-alb/tsconfig.json"),
    ...packs("express", "fetch"),
  ]),
  fixture("aws-config-stores", [
    ...dir("fixtures/aws-config-stores"),
    ...packs("aws-lambda", "aws-secrets-manager", "aws-ssm"),
  ]),
  fixture("aws-eventbridge", [
    ...project("fixtures/aws-eventbridge/tsconfig.json"),
    ...packs("aws-lambda", "aws-eventbridge"),
  ]),
  fixture("aws-eventbridge-unions", [
    ...project("fixtures/aws-eventbridge-unions/tsconfig.json"),
    ...packs("aws-lambda", "aws-eventbridge"),
  ]),
  // aws-sqs too, so the SQS receive in its helper is read.
  fixture("aws-lambda", [
    ...dir("fixtures/aws-lambda"),
    ...packs("aws-lambda", "aws-sqs", "node"),
  ]),
  fixture("aws-nested-stacks", [
    ...dir("fixtures/aws-nested-stacks"),
    ...packs("aws-lambda"),
  ]),
  fixture("aws-sns", [
    ...project("fixtures/aws-sns/tsconfig.json"),
    ...packs("aws-lambda", "aws-sns"),
  ]),
  fixture("aws-sqs", [
    ...project("fixtures/aws-sqs/tsconfig.json"),
    ...packs("aws-lambda", "aws-sqs"),
  ]),
  fixture("aws-stub-producer", [
    ...project("fixtures/aws-stub-producer/tsconfig.json"),
    ...packs("aws-lambda", "aws-sqs", "aws-eventbridge"),
  ]),
  fixture("axios", [...dir("fixtures/axios"), ...packs("axios")]),
  fixture("axios/generated-sdk", [
    ...dir("fixtures/axios/generated-sdk"),
    ...packs("axios"),
  ]),
  fixture("body-field-guards", [
    ...dir("fixtures/body-field-guards"),
    ...packs("nextjs", "fetch"),
  ]),
  fixture("cloudflare-worker-stores", [
    ...dir("fixtures/cloudflare-worker-stores"),
    ...packs(
      withConfig("cloudflare-workers", { scriptName: "edge-cache" }),
      "aws-dynamodb",
    ),
  ]),
  fixture("cloudflare-worker-triggers", [
    ...project("fixtures/cloudflare-worker-triggers/tsconfig.json"),
    ...packs(
      "cloudflare-workers=fixtures/cloudflare-worker-triggers/suss.cloudflare-workers.json",
    ),
  ]),
  fixture("cloudflare-worker-triggers/typed", [
    ...project("fixtures/cloudflare-worker-triggers/typed/tsconfig.json"),
    ...packs("cloudflare-workers"),
  ]),
  ...COMPAT_CASES.map((sub) =>
    fixture(`compat/${sub}`, [
      ...project(`fixtures/compat/${sub}/tsconfig.json`),
      ...packs("aws-lambda"),
    ]),
  ),
  fixture("compat/no-tsconfig", [
    ...dir("fixtures/compat/no-tsconfig"),
    ...packs("aws-lambda"),
  ]),
  // Adapter tests read this with no pack. The node pack applies to every
  // file, so the run summarizes each exported function.
  fixture("conditions", [...dir("fixtures/conditions"), ...packs("node")]),
  fixture("covered-by-minitest", [
    ...lang("ruby"),
    ...dir("fixtures/covered-by-minitest"),
    ...packs("minitest"),
    "--intent",
    "fixtures/covered-by-minitest/intent",
  ]),
  fixture("covered-by-pytest", [
    ...lang("python"),
    ...dir("fixtures/covered-by-pytest"),
    ...packs("pytest"),
    "--intent",
    "fixtures/covered-by-pytest/intent",
  ]),
  fixture("covered-by-rspec", [
    ...lang("ruby"),
    ...dir("fixtures/covered-by-rspec"),
    ...packs("rspec"),
    "--intent",
    "fixtures/covered-by-rspec/intent",
  ]),
  fixture("declaration-positions-ruby", [
    ...lang("ruby"),
    ...dir("fixtures/declaration-positions-ruby"),
    ...packs(
      withConfig("graphql-ruby", {
        root: inBase("fixtures/declaration-positions-ruby/app/graphql"),
      }),
      withConfig("activerecord", POSTGRES),
    ),
  ]),
  // The tests read this with a package-exports pack built in memory; -f node
  // is the nearest CLI form.
  fixture("dispatch-edges", [
    ...project("fixtures/dispatch-edges/tsconfig.json"),
    ...packs("node"),
  ]),
  fixture("dispatch-edges-python", [
    ...lang("python"),
    ...dir("fixtures/dispatch-edges-python"),
    ...packs("fastapi"),
  ]),
  fixture("dispatch-edges-ruby", [
    ...lang("ruby"),
    ...dir("fixtures/dispatch-edges-ruby"),
    ...packs("rails"),
  ]),
  fixture("drizzle", [
    ...project("fixtures/drizzle/tsconfig.json"),
    ...packs("express", "drizzle"),
  ]),
  fixture("dynamodb-signed-request", [
    ...dir("fixtures/dynamodb-signed-request"),
    ...packs("express", "aws-dynamodb"),
  ]),
  fixture("express", [...dir("fixtures/express"), ...packs("express")]),
  fixture("express-admin-audit", [
    ...project("fixtures/express-admin-audit/tsconfig.json"),
    ...packs("express", "pg"),
  ]),
  fixture("express-helper-twice", [
    ...dir("fixtures/express-helper-twice"),
    ...packs("express"),
  ]),
  fixture("express-helpers", [
    ...dir("fixtures/express-helpers"),
    ...packs("express"),
  ]),
  fixture("express-tenant", [
    ...dir("fixtures/express-tenant"),
    ...packs("express", "pg"),
  ]),
  fixture("express-two-apps", [
    ...dir("fixtures/express-two-apps"),
    ...packs("express"),
  ]),
  fixture("fastapi-tenant", [
    ...lang("python"),
    ...dir("fixtures/fastapi-tenant"),
    ...packs(
      "fastapi",
      "sqlalchemy=fixtures/fastapi-tenant/suss.sqlalchemy.json",
    ),
  ]),
  fixture("fastify", [...dir("fixtures/fastify"), ...packs("fastify")]),
  fixture("fetch", [...dir("fixtures/fetch"), ...packs("fetch")]),
  contract(
    "graphql-documents",
    "graphql-documents",
    "fixtures/graphql-documents",
  ),
  fixture("hono", [...dir("fixtures/hono"), ...packs("hono")]),
  fixture("hono-openapi", [...dir("fixtures/hono-openapi"), ...packs("hono")]),
  fixture("lambda-invoke", [
    ...dir("fixtures/lambda-invoke"),
    ...packs("aws-lambda"),
  ]),
  fixture("message-payload-drift", [
    ...dir("fixtures/message-payload-drift"),
    ...packs("aws-lambda", "aws-sqs"),
  ]),
  fixture("modules-python", [
    ...dir("fixtures/modules-python"),
    ...packs("sqlalchemy=fixtures/modules-python/suss.sqlalchemy.json"),
  ]),
  fixture("modules-ruby", [
    ...dir("fixtures/modules-ruby"),
    ...packs("pg-ruby"),
  ]),
  fixture("modules-typescript", [
    ...dir("fixtures/modules-typescript/src"),
    ...packs("pg"),
  ]),
  fixture("mongoose", [
    ...project("fixtures/mongoose/tsconfig.json"),
    ...packs("mongoose"),
  ]),
  fixture("nestjs-graphql", [
    ...dir("fixtures/nestjs-graphql"),
    ...packs("nestjs-graphql"),
  ]),
  ...[
    "nestjs-rest",
    "nestjs-rest-app",
    "nestjs-rest-bootstrap",
    "nestjs-rest-declared",
    "nestjs-rest-versioned/header",
    "nestjs-rest-versioned/off",
    "nestjs-rest-versioned/unread",
    "nestjs-rest-versioned/uri",
  ].map((name) =>
    fixture(name, [...dir(`fixtures/${name}`), ...packs("nestjs-rest")]),
  ),
  fixture("nextjs", [...dir("fixtures/nextjs"), ...packs("nextjs")]),
  fixture("node-runtime", [
    ...project("fixtures/node-runtime/tsconfig.json"),
    ...packs("express", "node"),
  ]),
  fixture("path-aliases", [
    ...project("fixtures/path-aliases/tsconfig.json"),
    ...packs("hono"),
  ]),
  fixture("per-site-client", [
    ...dir("fixtures/per-site-client"),
    ...packs("axios"),
  ]),
  fixture("per-site-client-python", [
    ...lang("python"),
    ...dir("fixtures/per-site-client-python"),
    ...packs("requests"),
  ]),
  fixture("per-site-client-ruby", [
    ...lang("ruby"),
    ...dir("fixtures/per-site-client-ruby"),
    ...packs("faraday"),
  ]),
  fixture("predicates", [...dir("fixtures/predicates"), ...packs("node")]),
  fixture(
    "prisma",
    [...project("fixtures/prisma/tsconfig.json"), ...packs("prisma")],
    { prepare: prismaGenerate("fixtures/prisma/schema.prisma") },
  ),
  fixture(
    "prisma-generated-client",
    [
      ...project("fixtures/prisma-generated-client/tsconfig.json"),
      ...packs("hono", "prisma"),
    ],
    {
      prepare: prismaGenerate("fixtures/prisma-generated-client/schema.prisma"),
    },
  ),
  // The acceptance journey reads this without `prisma generate`, so the
  // schema folder decides the storage system.
  fixture("prisma-multi-file", [
    ...project("fixtures/prisma-multi-file/tsconfig.json"),
    ...packs("express", "prisma"),
  ]),
  fixture(
    "prisma-module",
    [
      ...project("fixtures/prisma-module/tsconfig.json"),
      ...packs("hono", "prisma"),
    ],
    { prepare: prismaGenerate("fixtures/prisma/schema.prisma") },
  ),
  fixture("python-fastapi", [
    ...dir("fixtures/python-fastapi"),
    ...packs("fastapi"),
  ]),
  fixture("python-job", [
    ...lang("python"),
    ...dir("fixtures/python-job"),
    ...packs(withConfig("sqlalchemy", POSTGRES)),
  ]),
  ...PYTHON_SOURCE_ROOTS.map((sub) =>
    fixture(`python-source-roots/${sub}`, [
      ...dir(`fixtures/python-source-roots/${sub}`),
      ...packs("fastapi"),
    ]),
  ),
  fixture("python-webapp", [
    ...lang("python"),
    ...dir("fixtures/python-webapp"),
    ...packs("fastapi", "flask-restx"),
  ]),
  fixture("queue-consumer-closure", [
    ...project("fixtures/queue-consumer-closure/tsconfig.json"),
    ...packs("aws-lambda", "aws-sqs", "fetch"),
  ]),
  fixture("queue-consumer-closure-python", [
    ...lang("python"),
    ...dir("fixtures/queue-consumer-closure-python"),
    ...packs("requests"),
  ]),
  fixture("queue-consumer-closure-ruby", [
    ...lang("ruby"),
    ...dir("fixtures/queue-consumer-closure-ruby"),
    ...packs("faraday"),
  ]),
  fixture("queue-consumer-store", [
    ...dir("fixtures/queue-consumer-store"),
    ...packs("aws-lambda", "aws-sqs", "aws-dynamodb"),
  ]),
  fixture("rails-graphql-app", [
    ...lang("ruby"),
    ...dir("fixtures/rails-graphql-app"),
    ...packs(
      withConfig("graphql-ruby", {
        root: inBase("fixtures/rails-graphql-app/app/graphql"),
      }),
      railsIn("fixtures/rails-graphql-app"),
      withConfig("activerecord", POSTGRES),
    ),
  ]),
  fixture("rails-status-symbols", [
    ...lang("ruby"),
    ...dir("fixtures/rails-status-symbols"),
    ...packs("rails=fixtures/rails-status-symbols/suss.rails.json"),
  ]),
  fixture("rails-status-symbols/client", [
    ...dir("fixtures/rails-status-symbols/client"),
    ...packs("fetch"),
  ]),
  fixture("rails-tenant", [
    ...lang("ruby"),
    ...dir("fixtures/rails-tenant"),
    ...packs(
      "rails=fixtures/rails-tenant/suss.rails.json",
      "activerecord=fixtures/rails-tenant/suss.activerecord.json",
    ),
  ]),
  fixture("react", [...dir("fixtures/react"), ...packs("react")]),
  fixture("react-query", [
    ...project("fixtures/react-query/tsconfig.json"),
    ...packs("react", "react-query", "fetch"),
  ]),
  fixture("react-router", [
    ...dir("fixtures/react-router"),
    ...packs("react-router"),
  ]),
  // The pack's tests read one file's effects directly. From the CLI the
  // rails pack finds the controller actions that reach them.
  fixture("ruby-bigquery", [
    ...lang("ruby"),
    ...dir("fixtures/ruby-bigquery"),
    ...packs(railsIn("fixtures/ruby-bigquery"), "bigquery-ruby"),
  ]),
  fixture("ruby-graphql", [
    ...lang("ruby"),
    ...dir("fixtures/ruby-graphql"),
    ...packs(
      withConfig("graphql-ruby", {
        root: inBase("fixtures/ruby-graphql/app/graphql"),
      }),
    ),
  ]),
  fixture("ruby-graphql-resolvers", [
    ...lang("ruby"),
    ...dir("fixtures/ruby-graphql-resolvers"),
    ...packs(
      withConfig("graphql-ruby", {
        root: inBase("fixtures/ruby-graphql-resolvers/app/graphql"),
      }),
      withConfig("activerecord", POSTGRES),
    ),
  ]),
  fixture("ruby-job", [
    ...lang("ruby"),
    ...dir("fixtures/ruby-job"),
    ...packs(withConfig("activerecord", POSTGRES)),
  ]),
  fixture("ruby-pg", [
    ...lang("ruby"),
    ...dir("fixtures/ruby-pg"),
    ...packs(railsIn("fixtures/ruby-pg"), "pg-ruby"),
  ]),
  fixture("ruby-rails", [
    ...lang("ruby"),
    ...dir("fixtures/ruby-rails"),
    ...packs(
      railsIn("fixtures/ruby-rails"),
      withConfig("activerecord", POSTGRES),
    ),
  ]),
  ...[
    "runtime-config",
    "runtime-config-globals",
    "runtime-config-shared-code",
  ].map((name) =>
    fixture(name, [
      ...project(`fixtures/${name}/tsconfig.json`),
      ...packs("aws-lambda", "node"),
    ]),
  ),
  fixture("runtime-config-python", [
    ...lang("python"),
    ...dir("fixtures/runtime-config-python"),
    ...packs("fastapi"),
  ]),
  contract("schema-mirror", "prisma", "fixtures/schema-mirror/schema.prisma"),
  fixture("semantic-bridging", [
    ...dir("fixtures/semantic-bridging"),
    ...packs("ts-rest"),
  ]),
  contract("serverless", "serverless", "fixtures/serverless/serverless.yml"),
  // The aws-lambda pack reads only SAM templates, so nothing discovers
  // these handlers and the node pack makes their summaries.
  fixture("serverless/src", [
    ...project("fixtures/serverless/tsconfig.json"),
    ...packs("aws-sqs", "node"),
  ]),
  fixture("split-routes", [...dir("fixtures/split-routes"), ...packs("hono")]),
  contract(
    "storage-filters",
    "prisma",
    "fixtures/storage-filters/schema.prisma",
  ),
  fixture("storage-filters/python", [
    ...lang("python"),
    ...dir("fixtures/storage-filters/python"),
    ...packs(
      "fastapi",
      "sqlalchemy=fixtures/storage-filters/python/suss.sqlalchemy.json",
    ),
  ]),
  fixture("storage-filters/ruby", [
    ...lang("ruby"),
    ...dir("fixtures/storage-filters/ruby"),
    ...packs(
      "rails=fixtures/storage-filters/ruby/suss.rails.json",
      "activerecord=fixtures/storage-filters/ruby/suss.activerecord.json",
    ),
  ]),
  fixture("storage-wrapper", [
    ...dir("fixtures/storage-wrapper"),
    ...packs("aws-lambda", "aws-dynamodb"),
  ]),
  contract("storybook", "storybook", "fixtures/storybook"),
  contract("storybook-imports", "storybook", "fixtures/storybook-imports/src"),
  fixture("subject-positions", [
    ...dir("fixtures/subject-positions"),
    ...packs("express"),
  ]),
  fixture("subject-positions-python", [
    ...lang("python"),
    ...dir("fixtures/subject-positions-python"),
    ...packs("fastapi"),
  ]),
  fixture("subjects", [...dir("fixtures/subjects"), ...packs("node")]),
  fixture("supervisor-accounts", [
    ...project("fixtures/supervisor-accounts/tsconfig.json"),
    ...packs("aws-lambda", "fetch", "node"),
  ]),
  fixture("supervisor-listings", [
    ...lang("ruby"),
    ...dir("fixtures/supervisor-listings"),
    ...packs(
      "graphql-ruby=fixtures/supervisor-listings/suss.graphql-ruby.json",
    ),
  ]),
  fixture("supervisor-listings/client", [
    ...project("fixtures/supervisor-listings/tsconfig.json"),
    ...packs("apollo-client", "react"),
  ]),
  fixture("supervisor-orders", [
    ...project("fixtures/supervisor-orders/tsconfig.json"),
    ...packs("express", "fetch", "pg"),
  ]),
  fixture("terraform-stores", [
    ...dir("fixtures/terraform-stores"),
    ...packs("express", "gcs", "redis", "aws-s3"),
  ]),
  ...["ts-rest", "ts-rest-client", "ts-rest-composed"].map((name) =>
    fixture(name, [...dir(`fixtures/${name}`), ...packs("ts-rest")]),
  ),
  fixture("typeorm", [
    ...project("fixtures/typeorm/tsconfig.json"),
    ...packs("nestjs-rest", "typeorm"),
  ]),
  fixture("typescript-job", [
    ...dir("fixtures/typescript-job"),
    ...packs("pg"),
  ]),
  // The API package, read with its own tsconfig the way init writes it.
  fixture("typescript-monorepo", [
    ...project("fixtures/typescript-monorepo/packages/api/tsconfig.json"),
    ...packs("express"),
  ]),
  fixture("wrapped-routes", [
    ...dir("fixtures/wrapped-routes"),
    ...packs("hono"),
  ]),
  fixture("wrapped-routes-fastapi", [
    ...dir("fixtures/wrapped-routes-fastapi"),
    ...packs("fastapi"),
  ]),
  fixture("wrapped-routes-flask", [
    ...dir("fixtures/wrapped-routes-flask"),
    ...packs("flask-restx"),
  ]),
  fixture("wrapped-routes-nextjs", [
    ...dir("fixtures/wrapped-routes-nextjs"),
    ...packs("nextjs", "fetch"),
  ]),
  fixture("wrapped-set-timeout", [
    ...project("fixtures/wrapped-set-timeout/tsconfig.json"),
    ...packs("react", "express", "node", "fetch"),
  ]),
];

/** Five of suss's own packages, read from the main build's checkout. */
export const SELF_INPUTS = [
  "cli",
  "mcp",
  "checker",
  "datalog",
  "behavioral-ir",
].map((pkg) => ({
  name: `@suss/${pkg}`,
  group: "self",
  args: [
    ...project(`packages/${pkg}/tsconfig.json`),
    ...packs("package-exports", "node"),
  ],
}));

/**
 * The field apps every run reads, unless --quick. Each is read at its
 * tools/first-run/repos.json or libraryRepos.json commit, from a clone the first-run tool made,
 * with the packs and options the first run used.
 */
export const FIELD_INPUTS = [
  {
    name: "cal.com apps/web",
    group: "field",
    repo: "cal.com",
    args: [
      ...dir("apps/web"),
      ...packs("react-query", "nextjs", "react", "fetch", "node"),
    ],
  },
  {
    name: "dispatch",
    group: "field",
    repo: "dispatch",
    args: [
      ...lang("python"),
      ...packs(
        "fastapi",
        "aiohttp",
        "httpx",
        "requests",
        withConfig("sqlalchemy", POSTGRES),
      ),
    ],
  },
  {
    name: "mastodon",
    group: "field",
    repo: "mastodon",
    args: [
      ...lang("ruby"),
      ...packs(
        railsIn("."),
        "net-http",
        "pg-ruby",
        withConfig("activerecord", POSTGRES),
      ),
    ],
  },
];

/**
 * Apps that each exercise one library no standard input reaches in the
 * field, which --extra adds to a run. The packs are the ones `suss init`
 * suggests for each.
 */
export const EXTRA_INPUTS = [
  {
    name: "drizzle",
    group: "extra",
    repo: "saas-starter",
    args: packs("nextjs", "react", "fetch", "drizzle", "node"),
  },
  {
    name: "mongoose",
    group: "extra",
    repo: "saas",
    args: [
      ...dir("saas/api"),
      ...packs("express", "fetch", "mongoose", "node"),
    ],
  },
  {
    name: "sqs-sam",
    group: "extra",
    repo: "di-account-management-backend",
    args: [
      ...lang("typescript"),
      ...packs(
        "aws-lambda",
        "axios",
        "fetch",
        "aws-dynamodb",
        "aws-secrets-manager",
        "aws-sns",
        "aws-sqs",
        "node",
      ),
    ],
  },
  {
    name: "dynamodb",
    group: "extra",
    repo: "tooljet",
    args: [
      ...project("plugins/packages/dynamodb/tsconfig.json"),
      ...packs("aws-dynamodb"),
    ],
  },
];
