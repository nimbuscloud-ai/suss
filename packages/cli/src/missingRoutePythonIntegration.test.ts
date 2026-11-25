/**
 * A route renamed in a Python service, with a client left calling the
 * old path through a base URL its deployment sets: a FastAPI app a
 * Python Lambda calls, and a flask-restx app a Worker calls. Each
 * reports the one call once. Neither reports it once something the
 * framework serves beside its routes covers the path: a static folder,
 * an app or a blueprint the pack does not read, a catch-all route, a
 * router a library builds, or middleware or an error handler that
 * responds itself.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  contract,
  edit,
  fixtureCopier,
  missingRoutes,
  python,
  typescript,
} from "./__fixtures__/missingRoute.js";

import type { Finding } from "@suss/behavioral-ir";

const copyOf = fixtureCopier("suss-missing-route-py-");

/** The shop's FastAPI app, and the sync job whose Lambda deployment sets the shop's address. */
async function fastapiFindings(app: string): Promise<Finding[]> {
  const sync = path.join(app, "sync");
  return missingRoutes(app, [
    { cwd: path.join(app, "shop"), argv: python("fastapi") },
    { cwd: sync, argv: python("httpx", "aws-lambda-python") },
    { cwd: sync, argv: contract("serverless", "serverless.yml") },
  ]);
}

/** The shop's flask-restx app, and the storefront Worker whose deployment sets the shop's address. */
async function flaskFindings(app: string): Promise<Finding[]> {
  const web = path.join(app, "web");
  return missingRoutes(app, [
    { cwd: path.join(app, "shop"), argv: python("flask-restx") },
    { cwd: web, argv: typescript("fetch") },
    { cwd: web, argv: contract("wrangler", "wrangler.toml") },
  ]);
}

const FASTAPI_RENAMED =
  "sync_order calls GET /orders/{param}/summary, and the service it calls does not serve that path. Every call gets a 404. Routes nearby: GET /orders/{order_id}/totals.";

describe("a FastAPI app whose Lambda client calls a renamed route", () => {
  const main = (app: string): string =>
    path.join(app, "shop", "app", "main.py");

  it("reports the call once, and none of the calls a static mount, a mounted app or a path route serves", async () => {
    const findings = await fastapiFindings(
      copyOf("missing-route-fastapi", "fastapi"),
    );

    expect(findings.map((f) => f.description)).toEqual([FASTAPI_RENAMED]);
    expect(findings[0]?.consumer.summary).toBe("handler.py::sync_order");
  }, 120_000);

  it("reports nothing once a static mount covers the path", async () => {
    const app = copyOf("missing-route-fastapi", "fastapi-static");
    fs.appendFileSync(
      main(app),
      '\napp.mount("/orders", StaticFiles(directory="archive"), name="archive")\n',
    );

    expect(await fastapiFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing once an app suss does not read is mounted over the path", async () => {
    const app = copyOf("missing-route-fastapi", "fastapi-mounted");
    fs.appendFileSync(main(app), '\napp.mount("/orders", make_asgi_app())\n');

    expect(await fastapiFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing when a catch-all route could serve the path", async () => {
    const app = copyOf("missing-route-fastapi", "fastapi-catch-all");
    edit(main(app), '@app.get("/files/{key:path}")', '@app.get("/{key:path}")');

    expect(await fastapiFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing once a router a library builds is included over the path", async () => {
    const app = copyOf("missing-route-fastapi", "fastapi-library-router");
    edit(
      main(app),
      'app.include_router(orders, prefix="/orders")',
      'app.include_router(orders, prefix="/orders")\napp.include_router(exports.router(), prefix="/orders")',
    );
    edit(
      main(app),
      "from prometheus_client import make_asgi_app",
      "from prometheus_client import make_asgi_app\nfrom order_exports import exports",
    );

    expect(await fastapiFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing once middleware on the app responds to a request itself", async () => {
    const app = copyOf("missing-route-fastapi", "fastapi-middleware");
    fs.appendFileSync(
      main(app),
      [
        "",
        "",
        '@app.middleware("http")',
        "async def legacy_summary(request, call_next):",
        '    if request.url.path.endswith("/summary"):',
        '        return JSONResponse({"total": 0})',
        "    return await call_next(request)",
        "",
      ].join("\n"),
    );
    edit(
      main(app),
      "from fastapi.staticfiles import StaticFiles",
      "from fastapi.responses import JSONResponse\nfrom fastapi.staticfiles import StaticFiles",
    );

    expect(await fastapiFindings(app)).toEqual([]);
  }, 120_000);
});

const FLASK_RENAMED =
  "loadSummary calls GET /api/orders/{id}/summary, and the service it calls does not serve that path. Every call gets a 404. Routes nearby: GET /api/orders/{order_id}/totals.";

describe("a flask-restx app whose Worker client calls a renamed route", () => {
  const shop = (app: string): string => path.join(app, "shop", "app.py");
  const storefront = (app: string): string =>
    path.join(app, "web", "src", "storefront.ts");

  it("reports the call once, and none of the calls the static folder, a blueprint, the Swagger document, a path route or a public host serves", async () => {
    const findings = await flaskFindings(
      copyOf("missing-route-flask-restx", "flask"),
    );

    expect(findings.map((f) => f.description)).toEqual([FLASK_RENAMED]);
    expect(findings[0]?.consumer.summary).toBe(
      "src/storefront.ts::loadSummary",
    );
  }, 120_000);

  it("reports nothing once the static folder is served over the path", async () => {
    const app = copyOf("missing-route-flask-restx", "flask-static");
    edit(
      shop(app),
      "app = Flask(__name__)",
      'app = Flask(__name__, static_url_path="/api/orders")',
    );
    edit(storefront(app), "/static/logo.png", "/api/orders/logo.png");

    expect(await flaskFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing once a blueprint the pack does not read is registered over the path", async () => {
    const app = copyOf("missing-route-flask-restx", "flask-blueprint");
    fs.appendFileSync(
      shop(app),
      [
        "",
        'archive = Blueprint("archive", __name__)',
        'app.register_blueprint(archive, url_prefix="/api/orders")',
        "",
      ].join("\n"),
    );

    expect(await flaskFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing when a catch-all route could serve the path", async () => {
    const app = copyOf("missing-route-flask-restx", "flask-catch-all");
    fs.appendFileSync(
      shop(app),
      [
        "",
        "",
        '@app.route("/<path:anything>")',
        "def single_page(anything):",
        '    return send_file("index.html")',
        "",
      ].join("\n"),
    );

    expect(await flaskFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing once a not-found handler serves a page", async () => {
    const app = copyOf("missing-route-flask-restx", "flask-not-found");
    fs.appendFileSync(
      shop(app),
      [
        "",
        "",
        "@app.errorhandler(404)",
        "def single_page(error):",
        '    return send_file("index.html")',
        "",
      ].join("\n"),
    );

    expect(await flaskFindings(app)).toEqual([]);
  }, 120_000);
});
