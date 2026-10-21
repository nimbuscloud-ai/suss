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

  it("takes over a lock file left without an id by a writer that died", async () => {
    const file = path.join(dir, "base.lock");
    fs.writeFileSync(file, "");
    const minuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(file, minuteAgo, minuteAgo);

    const lock = await acquireFolderLock(file, 1000);

    expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
    releaseFolderLock(lock);
  });

  it("waits on a lock file whose writer may still be writing its id", async () => {
    const file = path.join(dir, "base.lock");
    fs.writeFileSync(file, "");

    await expect(acquireFolderLock(file, 300)).rejects.toThrow(
      "for another suss process",
    );
  });

  it("passes on an error other than the file existing", async () => {
    const file = path.join(dir, "no-such-folder", "base.lock");

    await expect(acquireFolderLock(file, 300)).rejects.toThrow("ENOENT");
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
