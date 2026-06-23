import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { readJson, recoverJson, writeJson } from "../src/storage.js";

async function withTempConfig(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clipper-storage-"));
  const previous = {
    dataDir: config.dataDir,
    generatedDir: config.generatedDir,
    generatedVideoDir: config.generatedVideoDir,
    thumbnailDir: config.thumbnailDir,
    metadataDir: config.metadataDir,
    logDir: config.logDir
  };

  config.dataDir = path.join(root, "data");
  config.generatedDir = path.join(root, "generated");
  config.generatedVideoDir = path.join(config.generatedDir, "videos");
  config.thumbnailDir = path.join(config.generatedDir, "thumbnails");
  config.metadataDir = path.join(config.generatedDir, "metadata");
  config.logDir = path.join(config.generatedDir, "logs");

  t.after(async () => {
    Object.assign(config, previous);
    await fs.rm(root, { recursive: true, force: true });
  });

  return root;
}

test("writeJson backs up the previous data file and keeps only recent backups", async (t) => {
  await withTempConfig(t);

  for (let index = 0; index < 12; index += 1) {
    await writeJson("jobs", [{ id: index }]);
  }

  const backupDir = path.join(config.dataDir, ".backups");
  const backups = (await fs.readdir(backupDir))
    .filter((entry) => entry.startsWith("jobs.json.") && entry.endsWith(".bak"));

  assert.equal(backups.length, 10);

  const backupContents = await Promise.all(backups.map(async (entry) => {
    const raw = await fs.readFile(path.join(backupDir, entry), "utf8");
    return JSON.parse(raw);
  }));
  assert.ok(backupContents.some((items) => items[0]?.id === 10));
});

test("recoverJson restores the latest valid backup and skips invalid newer files", async (t) => {
  await withTempConfig(t);
  await writeJson("jobs", [{ id: "first" }]);
  await writeJson("jobs", [{ id: "second" }]);

  const backupDir = path.join(config.dataDir, ".backups");
  await fs.writeFile(
    path.join(backupDir, "jobs.json.9999-01-01T00-00-00-000Z.invalid.bak"),
    "{not-json",
    "utf8"
  );
  await fs.writeFile(path.join(config.dataDir, "jobs.json"), "{broken", "utf8");

  const recovered = await recoverJson("jobs");
  const jobs = await readJson("jobs", []);

  assert.equal(recovered.restored, true);
  assert.deepEqual(jobs, [{ id: "first" }]);
});
