// An agent about to change a route asks what calls it before what reads
// it. In each language, a route and the code that requests it are read,
// and both questions have to list the same caller.

import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runSuss, workspace } from "../harness.js";

interface AnswerJson {
  found: boolean;
  headline: string;
  items: Array<{ unit: string; relations?: string[] }>;
  needs: string[];
}

interface Project {
  label: string;
  files: Record<string, string>;
  extract: string[];
  route: string;
  caller: string;
  provider: string;
}

function writeProject(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

function asked(question: string, dir: string): AnswerJson {
  const run = runSuss(["ask", question, "--dir", dir, "--json"]);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as AnswerJson;
}

const PROJECTS: Project[] = [
  {
    label: "TypeScript",
    files: {
      "package.json":
        '{ "name": "shop", "dependencies": { "next": "^15.0.0" } }\n',
      "tsconfig.json":
        '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler" }, "include": ["app", "lib"] }\n',
      "app/api/orders/[id]/route.ts": `export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  return Response.json({ id: params.id, total: 10 });
}
`,
      "lib/billing.ts": `export async function orderTotal(id: string): Promise<number> {
  const res = await fetch(\`/api/orders/\${id}\`);
  return (await res.json()).total;
}
`,
    },
    extract: ["-f", "nextjs", "-f", "fetch"],
    route: "GET /api/orders/{id}",
    caller: "shop::lib/billing.ts::orderTotal",
    provider: "shop::app/api/orders/[id]/route.ts::GET",
  },
  {
    label: "Python",
    files: {
      "pyproject.toml":
        '[project]\nname = "shop"\ndependencies = ["fastapi", "requests"]\n',
      "app/main.py": `from fastapi import FastAPI

app = FastAPI()


@app.get("/orders/{order_id}")
def get_order(order_id: str):
    return {"id": order_id, "total": 10}
`,
      "app/billing.py": `import requests


def order_total(order_id: str) -> int:
    res = requests.get(f"/orders/{order_id}")
    return res.json()["total"]
`,
    },
    extract: ["--lang", "python", "-f", "fastapi", "-f", "requests"],
    route: "GET /orders/{order_id}",
    caller: "app/billing.py::order_total",
    provider: "app/main.py::get_order",
  },
  {
    label: "Ruby",
    files: {
      Gemfile: 'source "https://rubygems.org"\n\ngem "rails"\ngem "faraday"\n',
      "suss.rails.json":
        '{ "root": "app", "routesFile": "config/routes.rb" }\n',
      "config/routes.rb": `Rails.application.routes.draw do
  get "/orders/:id", to: "orders#show"
end
`,
      "app/controllers/orders_controller.rb": `class OrdersController < ApplicationController
  def show
    render json: { id: params[:id], total: 10 }
  end
end
`,
      "app/services/billing.rb": `class Billing
  def order_total(id)
    response = Faraday.get("/orders/#{id}")
    JSON.parse(response.body)["total"]
  end
end
`,
    },
    extract: ["--lang", "ruby", "-f", "rails=suss.rails.json", "-f", "faraday"],
    route: "GET /orders/{id}",
    caller: "app/services/billing.rb::order_total",
    provider: "app/controllers/orders_controller.rb::OrdersController.show",
  },
];

for (const project of PROJECTS) {
  describe(`ask what calls a ${project.label} route`, () => {
    const dir = path.join(workspace(`ask-calls-${project.label}`), "project");
    const summaries = path.join(dir, "summaries");

    beforeAll(() => {
      writeProject(dir, project.files);
      const extract = runSuss(
        [...["extract", ...project.extract], "-o", "summaries/code.json"],
        { cwd: dir },
      );
      expect(extract.status, extract.stderr).toBe(0);
    });

    it("lists the code that requests the route", () => {
      const calls = asked(`what calls ${project.route}`, summaries);

      expect(calls.found).toBe(true);
      expect(calls.headline).toBe(`1 unit calls ${project.route}:`);
      expect(calls.items).toEqual([
        expect.objectContaining({
          unit: expect.stringContaining(project.caller),
          relations: ["reads", "writes"],
        }),
      ]);
      expect(calls.needs).toEqual([
        `${project.route} is provided by ${project.provider}.`,
      ]);
    });

    it("lists the same units what reads lists", () => {
      const calls = asked(`what calls ${project.route}`, summaries);
      const reads = asked(`what reads ${project.route}`, summaries);

      expect(calls.items.map((item) => item.unit)).toEqual(
        reads.items.map((item) => item.unit),
      );
    });
  });
}
