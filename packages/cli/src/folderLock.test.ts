import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireFolderLock, releaseFolderLock } from "./folderLock.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-lock-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The id of a process that has already exited. */
function exitedPid(): number {
  const run = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(String(process.pid))"],
    {
      encoding: "utf8",
    },
  );
  return Number(run.stdout);
}

describe("acquireFolderLock", () => {
  it("writes this process's id and removes the file on release", async () => {
    const file = path.join(dir, "base.lock");

    const lock = await acquireFolderLock(file, 1000);
    expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
    releaseFolderLock(lock);

    expect(fs.existsSync(file)).toBe(false);
  });

  it("takes over a lock whose process has exited", async () => {
    const file = path.join(dir, "base.lock");
    fs.writeFileSync(file, String(exitedPid()));

    const lock = await acquireFolderLock(file, 1000);

    expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
    releaseFolderLock(lock);
  });

  it("waits for a live holder and gives up after the timeout", async () => {
    const file = path.join(dir, "base.lock");
    fs.writeFileSync(file, String(process.ppid));

    await expect(acquireFolderLock(file, 600)).rejects.toThrow(
      "Waited 1s for another suss process",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(String(process.ppid));
  });

  it("waits until the holder lets go, then takes the lock", async () => {
    const file = path.join(dir, "base.lock");
    const first = await acquireFolderLock(file, 1000);
    setTimeout(() => releaseFolderLock(first), 400);

    const second = await acquireFolderLock(file, 5000);

    expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
    releaseFolderLock(second);
  });
});
