import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const dataFiles = {
  themes: "themes.json",
  videos: "videos.json",
  prompts: "prompts.json",
  jobs: "jobs.json",
  history: "history.json"
};

const backupEligibleFiles = new Set([
  ...Object.values(dataFiles),
  "discovery-cache.json",
  "youtube-quota.json"
]);
const backupDirName = ".backups";
const maxBackupsPerFile = 10;

export async function ensureProjectDirs() {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(config.generatedDir, { recursive: true });
  await fs.mkdir(config.generatedVideoDir, { recursive: true });
  await fs.mkdir(config.thumbnailDir, { recursive: true });
  await fs.mkdir(config.metadataDir, { recursive: true });
  await fs.mkdir(config.logDir, { recursive: true });
  for (const filename of Object.values(dataFiles)) {
    const target = path.join(config.dataDir, filename);
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, "[]\n", "utf8");
    }
  }
}

function dataPath(name) {
  const filename = dataFiles[name] || name;
  return path.join(config.dataDir, filename);
}

function backupDir() {
  return path.join(config.dataDir, backupDirName);
}

function backupEligibleName(name) {
  const filename = dataFiles[name] || name;
  if (path.basename(filename) !== filename) return "";
  if (!backupEligibleFiles.has(filename)) return "";
  if (!filename.endsWith(".json")) return "";
  return filename;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function createJsonBackup(name, target) {
  const filename = backupEligibleName(name);
  if (!filename) return null;

  try {
    await fs.access(target);
  } catch {
    return null;
  }

  try {
    const dir = backupDir();
    await fs.mkdir(dir, { recursive: true });
    const backupFile = path.join(dir, `${filename}.${backupTimestamp()}.${process.hrtime.bigint()}.bak`);
    await fs.copyFile(target, backupFile);
    await pruneJsonBackups(filename);
    return backupFile;
  } catch (error) {
    console.warn(`JSON backup dilewati untuk ${filename}: ${error.message}`);
    return null;
  }
}

async function jsonBackupsForFilename(filename) {
  try {
    const entries = await fs.readdir(backupDir());
    return entries
      .filter((entry) => entry.startsWith(`${filename}.`) && entry.endsWith(".bak"))
      .sort();
  } catch {
    return [];
  }
}

async function pruneJsonBackups(filename) {
  const backups = await jsonBackupsForFilename(filename);
  const stale = backups.slice(0, Math.max(0, backups.length - maxBackupsPerFile));
  await Promise.all(stale.map((entry) => fs.rm(path.join(backupDir(), entry), { force: true })));
}

export async function readJson(name, fallback = []) {
  try {
    const raw = await fs.readFile(dataPath(name), "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(name, data) {
  await ensureProjectDirs();
  const target = dataPath(name);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await createJsonBackup(name, target);
  await fs.rename(temp, target);
}

/**
 * Manually restore the latest valid backup for a JSON data file.
 * This is never called automatically; use it only after inspecting a corrupt
 * data file and choosing to roll back to the newest parseable backup.
 */
export async function recoverJson(name) {
  await ensureProjectDirs();
  const filename = backupEligibleName(name);
  if (!filename) {
    return { restored: false, reason: "not_backup_eligible" };
  }

  const backups = (await jsonBackupsForFilename(filename)).reverse();
  for (const entry of backups) {
    const backupFile = path.join(backupDir(), entry);
    try {
      const raw = await fs.readFile(backupFile, "utf8");
      JSON.parse(raw);
      const target = dataPath(name);
      const temp = `${target}.recover.tmp`;
      await fs.writeFile(temp, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
      await fs.rename(temp, target);
      return { restored: true, backup: backupFile, target };
    } catch {
      // Keep looking for the next newest valid backup.
    }
  }

  return { restored: false, reason: "no_valid_backup" };
}

export async function upsertItem(name, item, key = "id") {
  const list = await readJson(name, []);
  const index = list.findIndex((entry) => entry?.[key] === item?.[key]);
  if (index === -1) list.push(item);
  else list[index] = { ...list[index], ...item };
  await writeJson(name, list);
  return item;
}

export async function patchItem(name, id, patch) {
  const list = await readJson(name, []);
  const index = list.findIndex((entry) => entry.id === id || entry.job_id === id);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch, updated_at: new Date().toISOString() };
  await writeJson(name, list);
  return list[index];
}

export async function saveGeneratedJson(folder, filename, data) {
  const dir = path.join(config.generatedDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return filePath;
}
