// @suss/manifest-aws — parse CloudFormation / SAM templates into plain
// data. The shared facts layer for AWS deploy manifests.
//
// Two kinds of consumer read the same template with different roles:
// contract readers (@suss/contract-cloudformation, @suss/contract-appsync)
// treat it as a SPECIFICATION — declared routes, platform-injected
// transitions, queue wirings — while manifest-driven framework packs
// (@suss/framework-aws-lambda) treat it as a DISCOVERY INDEX — which
// source export is a handler, which route it serves. Keeping the parse
// here keeps those two witnesses independent: this package answers only
// "what does the template say", never what it means. It exports no IR
// and must not depend on any @suss package.

export {
  type AppSyncResolverBinding,
  readAppSyncResolvers,
} from "./appsyncResolvers.js";
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
