// What the deployable entries say, read through the reader they are
// written for. Each resource is written the way the provider docs show
// it, and once more with a name built from interpolation.

import { describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";
import { terraformToSummaries } from "@suss/contract-terraform";

import { googleTerraform } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const PACKS = { packs: [googleTerraform()] };

const CONFIGURATION = `
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

resource "google_storage_bucket" "uploads" {
  name = "\${local.environment}-uploads"
}

resource "google_cloud_run_v2_service" "api" {
  name     = "\${local.environment}-api"
  location = "us-central1"

  template {
    containers {
      image = "us-central1-docker.pkg.dev/example/api:3"

      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "UPLOADS_BUCKET"
        value = google_storage_bucket.uploads.name
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db.secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_job" "nightly" {
  name     = "nightly"
  location = "us-central1"

  template {
    template {
      containers {
        image = "us-central1-docker.pkg.dev/example/nightly:1"

        env {
          name  = "WINDOW_DAYS"
          value = "7"
        }
      }
    }
  }
}

resource "google_cloudfunctions2_function" "thumbnail" {
  name     = "thumbnail"
  location = "us-central1"

  build_config {
    runtime     = "nodejs20"
    entry_point = "makeThumbnail"
  }

  service_config {
    environment_variables = {
      UPLOADS_BUCKET = google_storage_bucket.uploads.name
    }

    secret_environment_variables {
      key     = "SIGNING_KEY"
      secret  = google_secret_manager_secret.signing.secret_id
      version = "latest"
    }
  }
}

resource "google_secret_manager_secret" "db" {
  secret_id = "\${local.environment}-db-password"
}

resource "google_secret_manager_secret" "signing" {
  secret_id = "\${local.environment}-signing-key"
}
`;

const SUMMARIES = terraformToSummaries(CONFIGURATION, "main.tf", PACKS);

function unit(instanceName: string): BehavioralSummary {
  const found = SUMMARIES.find(
    (summary) => summary.identity.deployableUnit?.instanceName === instanceName,
  );
  return found as BehavioralSummary;
}

describe("the Cloud Run service entry", () => {
  it("deploys one container unit, keyed by the resource label", () => {
    expect(unit("api").identity.deployableUnit).toEqual({
      deploymentTarget: "container",
      instanceName: "api",
    });
  });

  it("reads each env block, and the image the container runs", () => {
    const contract = readRuntimeContractMetadata(unit("api"));
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
    expect(contract?.envVarValues?.UPLOADS_BUCKET).toBe(
      "{local.environment}-uploads",
    );
    expect(contract?.image).toBe("us-central1-docker.pkg.dev/example/api:3");
  });

  it("points a variable at the resource its value refers to", () => {
    expect(
      readRuntimeContractMetadata(unit("api"))?.envVarTargets?.UPLOADS_BUCKET,
    ).toEqual({ kind: "ref", logicalId: "uploads" });
  });

  it("records which secret supplies a variable, and not its value", () => {
    const contract = readRuntimeContractMetadata(unit("api"));
    expect(contract?.envVarTargets?.DB_PASSWORD).toEqual({
      kind: "ref",
      logicalId: "db",
    });
    expect(contract?.envVarValues?.DB_PASSWORD).toBeUndefined();
  });

  it("adds the variables Cloud Run gives a service", () => {
    const contract = readRuntimeContractMetadata(unit("api"));
    expect(contract?.envVarSources?.K_SERVICE).toBe("platform");
    expect(contract?.envVarSources?.PORT).toBe("platform");
  });
});

describe("the Cloud Run job entry", () => {
  it("finds the containers one template deeper than a service's", () => {
    expect(
      readRuntimeContractMetadata(unit("nightly"))?.envVarValues?.WINDOW_DAYS,
    ).toBe("7");
  });

  it("adds the variables Cloud Run gives a job, and not a service's", () => {
    const contract = readRuntimeContractMetadata(unit("nightly"));
    expect(contract?.envVarSources?.CLOUD_RUN_TASK_INDEX).toBe("platform");
    expect(contract?.envVars).not.toContain("K_SERVICE");
  });
});

describe("the Cloud Functions entry", () => {
  it("reads the environment map and the secret variables together", () => {
    const contract = readRuntimeContractMetadata(unit("thumbnail"));
    expect(contract?.envVarValues?.UPLOADS_BUCKET).toBe(
      "{local.environment}-uploads",
    );
    expect(contract?.envVarTargets?.SIGNING_KEY).toEqual({
      kind: "ref",
      logicalId: "signing",
    });
  });

  it("records the entry point without claiming which file it is in", () => {
    const contract = readRuntimeContractMetadata(unit("thumbnail"));
    expect(contract?.entryPoint).toBe("makeThumbnail");
    expect(contract?.runtime).toBe("nodejs20");
    expect(unit("thumbnail").metadata?.codeScope).toEqual({ kind: "unknown" });
  });

  it("adds the variables a function's runtime injects", () => {
    expect(
      readRuntimeContractMetadata(unit("thumbnail"))?.envVarSources
        ?.FUNCTION_TARGET,
    ).toBe("platform");
  });
});
