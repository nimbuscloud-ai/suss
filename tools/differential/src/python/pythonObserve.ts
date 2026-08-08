// pythonObserve.ts: run generated apps under an interpreter and record
// what they actually serve.
//
// The runtime boundary mirrors what the roadmap grants a fuzzer
// target: the target language runs in this repo's own CI (or a
// developer's shell), never in the shipped package. The whole
// observation side is generated text handed to `python3`; nothing
// here imports or bundles Python.
//
// One interpreter process observes a whole batch, because importing
// fastapi and flask dominates per-program cost. Each program is a
// uniquely named package, so a batch of apps coexists in one process.
// Per program the observer records every route the framework itself
// reports (flask's url_map, fastapi's route table), restricted to
// views defined by the generated package, and probes each one with a
// single well-formed request to observe the answered status. A
// program that fails to import is reported as that program's error,
// never as an observation.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** One (path, method) the running app serves, with the unit that answers it and the status a well-formed probe observed. */
export interface ObservedEndpoint {
  path: string;
  method: string;
  /** The unit's summary-identity name: the endpoint function for fastapi, `Class.method` for flask-restx. */
  unit: string;
  status: number;
}

export interface ProgramObservation {
  program: string;
  endpoints: ObservedEndpoint[];
  error: string | null;
}

export interface ObserveManifestEntry {
  /** Directory name of the program inside the batch directory. */
  program: string;
  packageName: string;
  framework: "fastapi" | "flask-restx";
  /** JSON body per unit name, for routes whose probe must carry one. */
  requests: Record<string, Record<string, unknown>>;
}

export const DEFAULT_PYTHON = process.env.SUSS_FUZZ_PYTHON ?? "python3";

const REQUIRED_MODULES = ["flask", "flask_restx", "fastapi", "httpx"];

/**
 * Fail early, with the install command, when the interpreter or the
 * frameworks are missing. The differential cannot degrade here: no
 * runtime means no truth side. Answers the interpreter's version, and
 * names it in the failure too, so a wrong-interpreter mixup (a bare
 * python3 that is not the one the frameworks were installed into)
 * reads off the message instead of needing a shell to settle.
 */
export function assertPythonEnvironment(python: string): string {
  const versionProbe = spawnSync(
    python,
    ["-c", "import platform; print(platform.python_version())"],
    { encoding: "utf8" },
  );
  if (versionProbe.error !== undefined || versionProbe.status !== 0) {
    const detail = versionProbe.error?.message ?? versionProbe.stderr.trim();
    throw new Error(
      [
        `The Python differential needs an interpreter and "${python}" did not run (${detail}).`,
        "Point SUSS_FUZZ_PYTHON at a working python3.",
      ].join("\n"),
    );
  }
  const version = versionProbe.stdout.trim();

  const probe = spawnSync(
    python,
    ["-c", `import ${REQUIRED_MODULES.join(", ")}`],
    { encoding: "utf8" },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr.trim();
    throw new Error(
      [
        `The Python differential needs the target frameworks and "${python}" (Python ${version}) is missing them (${detail}).`,
        "Install them with: python3 -m pip install -r tools/differential/python/requirements.txt",
        "Point SUSS_FUZZ_PYTHON at a different interpreter if python3 is not the one.",
      ].join("\n"),
    );
  }
  return version;
}

// The observer itself is generated text, like the apps it observes.
// It answers with framework-reported truth only: route tables and
// probe statuses, no interpretation.
const OBSERVER_SOURCE = `import importlib
import json
import os
import re
import sys
import traceback

VERBS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


def fill_params(path):
    filled = re.sub(r"\\{[^{}/]+\\}", "1", path)
    return re.sub(r"<[^<>/]+>", "1", filled)


def canonical_path(path):
    # Werkzeug spells a template parameter as <name>, <converter:name>,
    # or <converter(arguments):name>; Starlette keeps a typed
    # converter in its route path ({name:int}). Extracted claims and
    # generated intents both speak the IR's bare-brace spelling, so
    # report the same one.
    stripped = re.sub(r"<(?:\\w+(?:\\(.*?\\))?:)?(\\w+)>", r"{\\1}", path)
    return re.sub(r"\\{(\\w+):\\w+\\}", r"{\\1}", stripped)


def observe_fastapi(package, requests):
    from fastapi.routing import APIRoute
    from fastapi.testclient import TestClient

    module = importlib.import_module(package + ".main")
    app = module.app
    client = TestClient(app, raise_server_exceptions=False)
    endpoints = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.endpoint.__module__.startswith(package + "."):
            continue
        unit = route.endpoint.__name__
        for method in sorted(route.methods & VERBS):
            response = client.request(
                method, fill_params(route.path), json=requests.get(unit)
            )
            endpoints.append(
                {
                    "path": canonical_path(route.path),
                    "method": method,
                    "unit": unit,
                    "status": response.status_code,
                }
            )
    return endpoints


def served_rule(app, rule):
    # A rule can carry repeated slashes: flask-restx concatenates a
    # blueprint prefix, an Api prefix and a namespace path as written.
    # Werkzeug answers those at the merged path and redirects the
    # written one, so the merged path is the one a client reaches.
    if app.url_map.merge_slashes:
        return re.sub(r"/{2,}", "/", rule.rule)
    return rule.rule


def observe_flask(package, requests):
    module = importlib.import_module(package + ".main")
    app = module.app
    client = app.test_client()
    endpoints = []
    for rule in app.url_map.iter_rules():
        view = app.view_functions.get(rule.endpoint)
        view_class = getattr(view, "view_class", None)
        if view_class is None:
            continue
        if not view_class.__module__.startswith(package):
            continue
        served = served_rule(app, rule)
        for method in sorted(rule.methods & VERBS):
            unit = view_class.__name__ + "." + method.lower()
            response = client.open(fill_params(served), method=method)
            endpoints.append(
                {
                    "path": canonical_path(served),
                    "method": method,
                    "unit": unit,
                    "status": response.status_code,
                }
            )
    return endpoints


OBSERVERS = {"fastapi": observe_fastapi, "flask-restx": observe_flask}


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, "manifest.json")) as handle:
        manifest = json.load(handle)
    results = []
    for entry in manifest["programs"]:
        sys.path.insert(0, os.path.join(root, entry["program"]))
        try:
            endpoints = OBSERVERS[entry["framework"]](
                entry["packageName"], entry.get("requests", {})
            )
            results.append(
                {"program": entry["program"], "endpoints": endpoints, "error": None}
            )
        except Exception:
            results.append(
                {
                    "program": entry["program"],
                    "endpoints": [],
                    "error": traceback.format_exc(),
                }
            )
        finally:
            sys.path.pop(0)
    with open(os.path.join(root, "observe-out.json"), "w") as handle:
        json.dump({"results": results}, handle)


main()
`;

/**
 * Observe every program under `batchDir` in one interpreter run. Each
 * manifest entry's program directory must already hold the rendered
 * files. Answers observations in manifest order.
 */
export function observeBatch(options: {
  batchDir: string;
  entries: ObserveManifestEntry[];
  python?: string;
}): ProgramObservation[] {
  const python = options.python ?? DEFAULT_PYTHON;
  fs.writeFileSync(
    path.join(options.batchDir, "manifest.json"),
    JSON.stringify({ programs: options.entries }),
  );
  fs.writeFileSync(path.join(options.batchDir, "observe.py"), OBSERVER_SOURCE);

  const run = spawnSync(python, ["observe.py"], {
    cwd: options.batchDir,
    encoding: "utf8",
    timeout: 600_000,
  });
  const outPath = path.join(options.batchDir, "observe-out.json");
  if (run.error !== undefined || run.status !== 0 || !fs.existsSync(outPath)) {
    const detail = run.error?.message ?? run.stderr;
    throw new Error(`the observer run failed as a whole:\n${detail}`);
  }

  const parsed = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
    results: ProgramObservation[];
  };
  return parsed.results;
}
