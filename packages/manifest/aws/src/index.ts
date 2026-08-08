/**
 * @suss/manifest-aws parses CloudFormation and SAM templates into plain
 * data. It is the shared facts layer for AWS deploy manifests.
 *
 * Two kinds of consumer read the same template for different reasons.
 * Contract readers (@suss/contract-cloudformation, @suss/contract-appsync)
 * read it as a SPECIFICATION: the routes it declares, the transitions the
 * platform injects, the queue wirings. Manifest-driven framework packs
 * (@suss/framework-aws-lambda) read it as a DISCOVERY INDEX: which source
 * export is a handler, and which route that handler serves. Parsing in one
 * place keeps those two witnesses independent, because this package reports
 * only what the template says and never what it means. It exports no IR and
 * must not depend on any @suss package.
 */

export {
  type AppSyncResolverBinding,
  readAppSyncResolvers,
} from "./appsyncResolvers.js";
export {
  resolveBucketChannel,
  resolveQueueChannel,
  resolveResourceChannel,
  resolveTopicChannel,
} from "./arn.js";
export {
  type PatternReduction,
  reduceEventPattern,
  resolveEventBusToken,
} from "./eventPattern.js";
export { inheritedEnvVars, resourcesWithGlobals } from "./globals.js";
export {
  loadTemplateTree,
  MAX_STACK_DEPTH,
  qualifiedLogicalId,
  type TemplateDocument,
  type TemplateTree,
  type UnfollowedReason,
  type UnfollowedStack,
  unfollowedStackMessage,
} from "./nestedStacks.js";
export {
  type ParsedHandler,
  parseHandler,
  readServerlessFunctions,
  type ServerlessFunctionInfo,
  type ServerlessHttpRoute,
  type ServerlessNonHttpEvent,
} from "./serverlessFunctions.js";
export {
  CLOUDFORMATION_YAML_TAGS,
  type CloudFormationResource,
  type CloudFormationTemplate,
  loadCloudFormationTemplate,
  refTarget,
} from "./templateLoader.js";
