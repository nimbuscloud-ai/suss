/**
 * The library side of the client URL check: the URL each library builds
 * for a case, asked of the library itself with nothing sent. httpx and
 * aiohttp run under python3, Faraday and Net::HTTP under Ruby with the
 * harness's own Gemfile, and axios in this process from the harness's
 * own install. A library that cannot be run is reported as unavailable,
 * and the other libraries still run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PYTHON } from "../python/pythonObserve.js";
import { HOLE_NAME, type Library, type UrlCase } from "./cases.js";
import { failureOf } from "./failure.js";
import { PYTHON_PROBE_SOURCE } from "./pythonProbe.js";

export type LibraryResult =
  | { readonly kind: "url"; readonly url: string }
  | {
      readonly kind: "refused";
      readonly reason: string;
      /** True when building the client with this base failed, before any call. */
      readonly base: boolean;
    };

/** A result per case id, or why the library could not be run at all. */
export type LibrarySide =
  | { readonly ok: true; readonly results: ReadonlyMap<string, LibraryResult> }
  | { readonly ok: false; readonly error: string };

/** What a hole becomes on the library side: text no library percent-encodes. */
export const HOLE_SENTINEL = "suss-hole";

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUBY_GEMFILE = path.join(HARNESS_ROOT, "ruby", "Gemfile");
const RUBY_PROBE = path.join(HARNESS_ROOT, "ruby", "urlProbe.rb");
const NODE_ORACLE = path.join(HARNESS_ROOT, "node");
const DEFAULT_RUBY = process.env.SUSS_FUZZ_RUBY ?? "ruby";

type Runner = "python" | "ruby" | "node";

const RUNNER_OF: Record<Library, Runner> = {
  httpx: "python",
  aiohttp: "python",
  faraday: "ruby",
  "net-http": "ruby",
  axios: "node",
};

/** What a probe prints for one case. Net::HTTP reports where it was going and the request target instead of a URL. */
interface ProbeResult {
  readonly id: string;
  readonly url?: string;
  readonly origin?: string;
  readonly target?: string;
  readonly refused?: string;
  readonly base?: boolean;
}

/** What axios's Node adapter hands `http.request`. */
interface TransportOptions {
  readonly protocol?: string;
  readonly hostname?: string;
  readonly port?: string | number;
  readonly path?: string;
}

interface AxiosLike {
  get(
    url: string,
    config: {
      proxy: false;
      transport: { request(options: TransportOptions): never };
    },
  ): Promise<unknown>;
  create(config: { baseURL: string }): AxiosLike;
}

function withSentinel(text: string): string {
  return text.replaceAll(`{${HOLE_NAME}}`, HOLE_SENTINEL);
}

const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A server takes the URL of a request sent with an absolute URL as its target from that URL, not from the connection (RFC 9112, section 3.2.2). */
function netHttpResult(origin: string, target: string): LibraryResult {
  if (target.startsWith("/")) {
    return { kind: "url", url: new URL(origin).origin + target };
  }

  if (ABSOLUTE_FORM.test(target)) {
    return { kind: "url", url: target };
  }

  return {
    kind: "refused",
    reason: `Net::HTTP sends ${JSON.stringify(target)} to ${new URL(origin).origin} as the request target, which is not a path`,
    base: false,
  };
}

function fromProbe(result: ProbeResult): LibraryResult {
  if (result.refused !== undefined) {
    return {
      kind: "refused",
      reason: result.refused,
      base: result.base ?? false,
    };
  }

  if (result.url !== undefined) {
    return { kind: "url", url: result.url };
  }

  return netHttpResult(result.origin ?? "", result.target ?? "");
}

function probeInput(cases: readonly UrlCase[]): string {
  return JSON.stringify(
    cases.map((c) => ({
      id: c.id,
      library: c.library,
      form: c.form,
      base: c.base,
      path: withSentinel(c.path),
      port: c.port,
    })),
  );
}

function runProbe(
  command: string,
  args: readonly string[],
  cases: readonly UrlCase[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; installHint: string },
): LibrarySide {
  const run = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: probeInput(cases),
    encoding: "utf8",
  });
  const failure = failureOf(run);
  if (failure !== null) {
    return {
      ok: false,
      error: `${command} ${args.join(" ")} failed: ${failure}. ${options.installHint}`,
    };
  }

  const results = new Map<string, LibraryResult>();
  for (const result of JSON.parse(run.stdout) as ProbeResult[]) {
    results.set(result.id, fromProbe(result));
  }

  return { ok: true, results };
}

function pythonSide(cases: readonly UrlCase[]): LibrarySide {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-client-urls-py-"));
  try {
    fs.writeFileSync(path.join(dir, "urlProbe.py"), PYTHON_PROBE_SOURCE);
    return runProbe(DEFAULT_PYTHON, ["urlProbe.py"], cases, {
      cwd: dir,
      installHint: `Install the pinned clients with ${DEFAULT_PYTHON} -m pip install -r tools/differential/python/requirements.txt, or point SUSS_FUZZ_PYTHON at an interpreter that has them.`,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rubySide(cases: readonly UrlCase[]): LibrarySide {
  return runProbe(DEFAULT_RUBY, ["-rbundler/setup", RUBY_PROBE], cases, {
    env: { ...process.env, BUNDLE_GEMFILE: RUBY_GEMFILE },
    installHint: `Install the pinned gems with BUNDLE_GEMFILE=${RUBY_GEMFILE} bundle install under Ruby 3 or later, or point SUSS_FUZZ_RUBY at a Ruby that has them.`,
  });
}

/**
 * `getUri` returns the joined string before the Node adapter parses it
 * with `new URL`, which removes dot segments, so this stops the request
 * at the transport instead and reads what axios would pass to it.
 */
async function axiosResult(
  axios: AxiosLike,
  c: UrlCase,
): Promise<LibraryResult> {
  let sent: TransportOptions | null = null;
  const transport = {
    request(options: TransportOptions): never {
      sent = options;
      throw new Error("stopped before sending");
    },
  };
  const client = c.base === null ? axios : axios.create({ baseURL: c.base });
  try {
    await client.get(withSentinel(c.path), { proxy: false, transport });
  } catch (error) {
    const options = sent as TransportOptions | null;
    if (options === null) {
      return { kind: "refused", reason: (error as Error).message, base: false };
    }

    const port = options.port ? `:${options.port}` : "";
    return {
      kind: "url",
      url: `${options.protocol}//${options.hostname}${port}${options.path}`,
    };
  }

  throw new Error(`axios sent ${c.id} without calling its transport`);
}

async function nodeSide(cases: readonly UrlCase[]): Promise<LibrarySide> {
  let axios: AxiosLike;
  try {
    axios = createRequire(path.join(NODE_ORACLE, "package.json"))("axios");
  } catch (error) {
    return {
      ok: false,
      error: `axios is not installed beside the harness (${(error as Error).message}). Run npm ci --prefix tools/differential/node.`,
    };
  }

  const results = new Map<string, LibraryResult>();
  for (const c of cases) {
    results.set(c.id, await axiosResult(axios, c));
  }

  return { ok: true, results };
}

const RUNNERS: Record<
  Runner,
  (cases: readonly UrlCase[]) => LibrarySide | Promise<LibrarySide>
> = {
  python: pythonSide,
  ruby: rubySide,
  node: nodeSide,
};

/** Runs every case through its library, one probe run per language. */
export async function runLibrarySide(
  cases: readonly UrlCase[],
): Promise<Map<Library, LibrarySide>> {
  const sides = new Map<Library, LibrarySide>();
  for (const runner of Object.keys(RUNNERS) as Runner[]) {
    const ofRunner = cases.filter((c) => RUNNER_OF[c.library] === runner);
    if (ofRunner.length === 0) {
      continue;
    }

    const side = await RUNNERS[runner](ofRunner);
    for (const c of ofRunner) {
      sides.set(c.library, side);
    }
  }

  return sides;
}
