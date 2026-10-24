/**
 * The channel a pattern's declared binding states, read off whatever the
 * match found the handler through. A decorator selects a NestJS handler,
 * and a call hands a BullMQ processor over, so each source reads its own
 * site. A constant passed by name resolves to its written string, the
 * same hop a route path gets, and a value the run cannot settle leaves
 * the channel null rather than spelling something wrong.
 */

import { Node } from "ts-morph";

import { stringValueOf } from "./resolveValue.js";

import type { ChannelSource } from "@suss/extractor";
import type { CallExpression, NewExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/** What a match found the handler through. */
export interface HandlerSite {
  /** The decorator that selected the handler. */
  readonly decorator?: Node;
  /** The call the handler was handed to. */
  readonly call?: CallExpression | NewExpression;
}

type Reader<TFrom extends ChannelSource["from"]> = (
  source: Extract<ChannelSource, { from: TFrom }>,
  site: HandlerSite,
  resolution: ResolutionStore | undefined,
) => string | null;

const CHANNEL_FROM: { [TFrom in ChannelSource["from"]]: Reader<TFrom> } = {
  literal: (source) => source.value,
  unstated: () => null,
  decoratorArgument: (source, site, resolution) =>
    site.decorator !== undefined && Node.isDecorator(site.decorator)
      ? settledChannel(
          site.decorator.getArguments()[source.position],
          resolution,
        )
      : null,
  callArgument: (source, site, resolution) =>
    site.call === undefined
      ? null
      : settledChannel(site.call.getArguments()[source.position], resolution),
};

export function declaredChannelOf(
  source: ChannelSource,
  site: HandlerSite,
  resolution: ResolutionStore | undefined,
): string | null {
  const read = CHANNEL_FROM[source.from] as Reader<ChannelSource["from"]>;
  return read(source, site, resolution);
}

function settledChannel(
  argument: Node | undefined,
  resolution: ResolutionStore | undefined,
): string | null {
  if (argument === undefined) {
    return null;
  }
  const text = stringValueOf(argument, resolution);
  return text === null || text === "" ? null : text;
}
