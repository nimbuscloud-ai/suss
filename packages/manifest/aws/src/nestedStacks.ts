/**
 * nestedStacks.ts reads a template and every child template it embeds, as a
 * list of documents.
 *
 * A stack resource points at another template, and CloudFormation deploys that
 * template's resources alongside the parent's. Each document keeps its own
 * namespace, its own SAM `Globals` section, and its own directory, so the tree
 * stays a list of documents. Merging them would apply one document's defaults
 * to another's resources, and let two logical ids spelled the same way collide.
 *
 * A child's reference to one of its own parameters is not followed to what the
 * parent bound, and a `Fn::GetAtt` on a stack resource is not followed to the
 * child's output. Both point at nothing, like any reference we can't resolve.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type CloudFormationTemplate,
  loadCloudFormationTemplate,
} from "./templateLoader.js";

/**
 * The property each embedding resource type uses to point at its child
 * template. `AWS::Serverless::Application` is SAM's spelling of the same
 * relationship, and its `Location` accepts a path the same way.
 */
const CHILD_TEMPLATE_PROPERTY: Record<string, string> = {
  "AWS::CloudFormation::Stack": "TemplateURL",
  "AWS::Serverless::Application": "Location",
};

/**
 * How deep the reader follows children. CloudFormation itself allows
 * deeper nesting; a template chain this long in a repository is far
 * more likely to be a mistake than a design, and the limit is reported
 * rather than applied silently.
 */
export const MAX_STACK_DEPTH = 10;

/** One template file, and where it lives in the tree that reached it. */
export interface TemplateDocument {
  /** Absolute path of the file this document was read from. */
  path: string;
  /**
   * Logical ids of the stack resources leading from the root document
   * down to this one. Empty for the root.
   */
  stackPath: string[];
  template: CloudFormationTemplate;
}

/**
 * Why a child template was not read. Every value is a limit on what the
 * reader could reach, so a consumer should report it as a read that
 * stopped rather than treat the child as an empty template.
 */
export type UnfollowedReason =
  | "remoteUrl"
  | "notALiteralPath"
  | "fileMissing"
  | "unreadable"
  | "cycle"
  | "depthLimit";

/** A child template the reader could not open, and what stopped it. */
export interface UnfollowedStack {
  /** Absolute path of the document declaring the stack resource. */
  declaredIn: string;
  /** Stack path of the child, ending in this stack resource's logical id. */
  stackPath: string[];
  /** The template location as the document writes it, when it is a string. */
  templateUrl: string | null;
  reason: UnfollowedReason;
  /** One phrase saying what stopped the read, for a message to a person. */
  detail: string;
}

export interface TemplateTree {
  /** The root document first, then every child that could be read. */
  documents: TemplateDocument[];
  unfollowed: UnfollowedStack[];
}

/**
 * The root template plus every template it embeds, directly or through
 * another child.
 *
 * A missing or malformed ROOT throws, matching
 * `loadCloudFormationTemplate`: the caller asked for that file by name.
 * A child that cannot be read never throws; it lands in `unfollowed` so
 * the caller can report which one and why.
 */
export function loadTemplateTree(rootPath: string): TemplateTree {
  const rootFile = path.resolve(rootPath);
  const root: TemplateDocument = {
    path: rootFile,
    stackPath: [],
    template: loadCloudFormationTemplate(rootFile),
  };

  const documents: TemplateDocument[] = [root];
  const unfollowed: UnfollowedStack[] = [];
  const queue: Array<{ document: TemplateDocument; ancestors: string[] }> = [
    { document: root, ancestors: [rootFile] },
  ];

  // Breadth first, so a document embedded at two depths is read at the
  // shallower one first and the tree is walked without recursion.
  for (let i = 0; i < queue.length; i += 1) {
    const { document, ancestors } = queue[i];
    for (const child of childStacksOf(document, ancestors)) {
      if (child.type === "unfollowed") {
        unfollowed.push(child.stack);
        continue;
      }
      documents.push(child.document);
      queue.push({
        document: child.document,
        ancestors: [...ancestors, child.document.path],
      });
    }
  }

  return { documents, unfollowed };
}

/**
 * A logical id qualified by the stack path that reaches it, so two
 * documents that both declare `HandlerFunction` refer to two different
 * deployed things. A resource in the root document keeps its bare id,
 * which is also what CloudFormation shows for it.
 */
export function qualifiedLogicalId(
  stackPath: string[],
  logicalId: string,
): string {
  return [...stackPath, logicalId].join("/");
}

/** A line saying which child the reader could not open, and why. */
export function unfollowedStackMessage(stack: UnfollowedStack): string {
  const name = stack.stackPath.join("/");
  return `could not follow nested stack ${name} declared in ${stack.declaredIn}: ${stack.detail}`;
}

type ChildStack =
  | { type: "document"; document: TemplateDocument }
  | { type: "unfollowed"; stack: UnfollowedStack };

function childStacksOf(
  document: TemplateDocument,
  ancestors: string[],
): ChildStack[] {
  const out: ChildStack[] = [];
  for (const [logicalId, resource] of Object.entries(
    document.template.Resources ?? {},
  )) {
    const property = CHILD_TEMPLATE_PROPERTY[resource.Type ?? ""];
    if (property === undefined) {
      continue;
    }
    out.push(
      childStack({
        document,
        ancestors,
        logicalId,
        location: resource.Properties?.[property],
      }),
    );
  }
  return out;
}

function childStack(opts: {
  document: TemplateDocument;
  ancestors: string[];
  logicalId: string;
  location: unknown;
}): ChildStack {
  const stackPath = [...opts.document.stackPath, opts.logicalId];
  const report = (
    reason: UnfollowedReason,
    detail: string,
    templateUrl: string | null,
  ): ChildStack => ({
    type: "unfollowed",
    stack: {
      declaredIn: opts.document.path,
      stackPath,
      templateUrl,
      reason,
      detail,
    },
  });

  const url = typeof opts.location === "string" ? opts.location.trim() : null;
  if (url === null || url === "") {
    return report(
      "notALiteralPath",
      "the template location is not a literal string",
      null,
    );
  }
  if (url.includes("${")) {
    // An `Fn::Sub` location parses back to the string with its tokens
    // still in it. Nothing static fills those in, so the path points at
    // no file at all, rather than at one that happens to be missing.
    return report(
      "notALiteralPath",
      `${url} holds a substitution nothing here can fill in`,
      url,
    );
  }
  if (hasUrlScheme(url)) {
    return report("remoteUrl", `${url} is not a path in this repository`, url);
  }
  if (stackPath.length > MAX_STACK_DEPTH) {
    return report(
      "depthLimit",
      `nesting is deeper than ${MAX_STACK_DEPTH} stacks`,
      url,
    );
  }

  const childPath = path.resolve(path.dirname(opts.document.path), url);
  if (opts.ancestors.includes(childPath)) {
    return report("cycle", `${url} is already open further up the tree`, url);
  }
  if (!fs.existsSync(childPath)) {
    return report("fileMissing", `${url} is not on disk`, url);
  }

  try {
    return {
      type: "document",
      document: {
        path: childPath,
        stackPath,
        template: loadCloudFormationTemplate(childPath),
      },
    };
  } catch (err) {
    return report(
      "unreadable",
      `${url} could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      url,
    );
  }
}

function hasUrlScheme(location: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location);
}
