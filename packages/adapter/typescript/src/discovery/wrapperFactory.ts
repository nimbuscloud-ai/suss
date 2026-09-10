/**
 * wrapperFactory.ts, what a wrapper written as a factory call goes by.
 *
 * `app.use(requireCaller(config))` and `router.post("/", validate(schema),
 * handler)` both register the function a factory returned. The app-level
 * index and the route chain read the same call, so what it is called
 * and what to record when it cannot be followed live here for both.
 */

import { Node } from "ts-morph";

import { factKeyOf } from "../facts/extract.js";
import {
  classifyStop,
  declarationsBehind,
  worthRecording,
} from "../resolve/unfollowedCall.js";

import type { UnfollowedCall } from "@suss/behavioral-ir";

/** The factory a wrapper argument calls, `requireCaller` for `requireCaller(config)`. */
export function factoryNameOf(targetArg: Node): string | undefined {
  const written = factKeyOf(targetArg);
  if (!Node.isCallExpression(written)) {
    return undefined;
  }
  const callee = written.getExpression();
  if (Node.isIdentifier(callee)) {
    return callee.getText();
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getName();
  }
  return undefined;
}

/**
 * The stop a registration leaves when the factory it calls could not be
 * followed to one function. A factory in a dependency leaves none, for
 * the reason the resolve README gives: `app.use(cors())` on every route
 * is volume, and the run already describes the dependency.
 */
export function factoryStopOf(targetArg: Node): UnfollowedCall | null {
  const written = factKeyOf(targetArg);
  if (!Node.isCallExpression(written)) {
    return null;
  }
  const callee = factoryNameOf(targetArg);
  if (callee === undefined) {
    return null;
  }
  const reason = classifyStop(
    declarationsBehind(written.getExpression().getSymbol()),
  );
  if (!worthRecording(reason)) {
    return null;
  }
  return { callee, reason: "unresolvedWrapper" };
}
