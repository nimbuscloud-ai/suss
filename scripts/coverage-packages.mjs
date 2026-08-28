// coverage-packages.mjs
//
// Single source of truth for which packages participate in coverage
// tracking. Both scripts/generate-coverage-badges.mjs (badge per
// package + workspace average) and scripts/check-coverage-threshold.mjs
// (per-package regression gate) read this list, so they can't drift
// apart and a new package is added in exactly one place.
//
// Each entry is [packageDir, badgeSlug]. The slug is the badge filename
// stem (.github/badges/coverage-<slug>.svg): kept stable across
// renames and disambiguated where a bare directory name would collide
// (framework/apollo → "apollo" vs client/apollo → "apollo-client").

export const coveragePackages = [
  // Core IR
  ["packages/ir-core", "ir-core"],
  ["packages/datalog", "datalog"],
  ["packages/resolution", "resolution"],
  ["packages/behavioral-ir", "ir"],
  ["packages/intent-ir", "intent-ir"],
  ["packages/extractor", "extractor"],
  ["packages/recognize", "recognize"],
  ["packages/adapter/typescript", "typescript"],
  ["packages/adapter/python", "python"],
  ["packages/adapter/ruby", "ruby"],
  ["packages/checker", "checker"],
  ["packages/checker-intent", "checker-intent"],
  ["packages/cli", "cli"],
  ["packages/mcp", "mcp"],
  // Frameworks
  ["packages/framework/ts-rest", "ts-rest"],
  ["packages/framework/react-router", "react-router"],
  ["packages/framework/react", "react"],
  ["packages/framework/react-query", "react-query"],
  ["packages/framework/express", "express"],
  ["packages/framework/gcs", "gcs"],
  ["packages/framework/fastify", "fastify"],
  ["packages/framework/hono", "hono"],
  ["packages/framework/nextjs", "nextjs"],
  ["packages/framework/apollo", "apollo"],
  ["packages/framework/nestjs-microservices", "nestjs-microservices"],
  ["packages/framework/package-exports", "package-exports"],
  ["packages/framework/nestjs-rest", "nestjs-rest"],
  ["packages/framework/nestjs-graphql", "nestjs-graphql"],
  ["packages/framework/prisma", "prisma"],
  ["packages/framework/redis", "redis"],
  ["packages/framework/zustand", "zustand"],
  ["packages/framework/drizzle", "drizzle"],
  ["packages/framework/mongoose", "mongoose"],
  ["packages/sql", "sql"],
  ["packages/contract/terraform", "contract-terraform"],
  ["packages/terraform/aws", "terraform-aws"],
  ["packages/terraform/gcp", "terraform-gcp"],
  ["packages/framework/aws-dynamodb", "aws-dynamodb"],
  ["packages/framework/aws-s3", "aws-s3"],
  ["packages/framework/aws-sqs", "aws-sqs"],
  ["packages/framework/aws-eventbridge", "aws-eventbridge"],
  ["packages/framework/aws-lambda", "aws-lambda"],
  ["packages/framework/cloudflare-workers", "cloudflare-workers"],
  ["packages/framework/flask-restx", "flask-restx"],
  ["packages/framework/fastapi", "fastapi"],
  ["packages/framework/sqlalchemy", "sqlalchemy"],
  ["packages/framework/activerecord", "activerecord"],
  ["packages/framework/graphql-ruby", "graphql-ruby"],
  // Clients
  ["packages/client/web", "web"],
  ["packages/client/axios", "axios"],
  ["packages/client/apollo", "apollo-client"],
  // Runtimes
  ["packages/runtime/node", "runtime-node"],
  // Contract sources
  ["packages/contract/openapi", "contract-openapi"],
  ["packages/contract/graphql", "contract-graphql"],
  ["packages/contract/aws-apigateway", "contract-aws-apigateway"],
  ["packages/contract/cloudformation", "contract-cloudformation"],
  ["packages/contract/serverless", "contract-serverless"],
  ["packages/contract/wrangler", "contract-wrangler"],
  ["packages/contract/appsync", "contract-appsync"],
  ["packages/contract/storybook", "contract-storybook"],
  ["packages/contract/prisma", "contract-prisma"],
  ["packages/contract/intent", "contract-intent"],
  // Manifests
  ["packages/manifest/aws", "manifest-aws"],
];
