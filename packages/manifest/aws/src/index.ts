/**
 * @suss/manifest-aws parses CloudFormation and SAM templates into plain
 * data for every suss reader of an AWS deploy manifest.
 *
 * Two kinds of reader use the same template for different things. The
 * contract readers (@suss/contract-cloudformation, @suss/contract-appsync)
 * treat it as a specification: the routes it declares, the transitions the
 * platform adds, the queue wiring. The Lambda pack (@suss/framework-aws-lambda)
 * uses it to find which source export is a handler and which route that
 * handler serves. This package reports what the template says and leaves
 * what it means to each reader, so the contract side and the code side stay
 * independent while sharing one parser. It exports no IR, and its only suss
 * dependency is @suss/ir-core, for the Handler string and path helpers.
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
