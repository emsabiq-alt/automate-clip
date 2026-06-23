import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { ensureProjectDirs, writeJson } from "../src/storage.js";
import { selectNextVideo } from "../src/selector.js";
import { queueSeriesClipRanges } from "../src/history.js";

async function withTempData(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clipper-queue-series-"));
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

  try {
    await ensureProjectDirs();
    await writeJson("themes", [{ name: "podcast artis", status: "active" }]);
    await writeJson("prompts", [{ id: "prompt_1", theme: "podcast artis" }]);
    return await callback();
  } finally {
    Object.assign(config, previous);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("scheduled series keeps the first link until it reaches three successes", async () => {
  await withTempData(async () => {
    await writeJson("videos", [
      {
        id: "video_1",
        url: "https://www.youtube.com/watch?v=11111111111",
        theme: "podcast artis",
        priority: 1,
        status: "failed",
        automation_series: true,
        series_target_count: 3,
        created_at: "2026-06-01T00:00:00.000Z"
      },
      {
        id: "video_2",
        url: "https://www.youtube.com/watch?v=22222222222",
        theme: "podcast artis",
        priority: 2,
        status: "queued",
        automation_series: true,
        series_target_count: 3,
        created_at: "2026-06-01T01:00:00.000Z"
      }
    ]);
    await writeJson("history", [
      {
        status: "published",
        queue_series: true,
        video_id: "video_1",
        source_url: "https://www.youtube.com/watch?v=11111111111"
      },
      {
        status: "published",
        queue_series: true,
        video_id: "video_1",
        source_url: "https://www.youtube.com/watch?v=11111111111"
      }
    ]);

    const selection = await selectNextVideo({ seriesMode: true, theme: "auto" });
    assert.equal(selection.video.id, "video_1");
    assert.equal(selection.video.series_success_count, 2);
  });
});

test("manual ad-hoc selection does not take automation series links", async () => {
  await withTempData(async () => {
    await writeJson("videos", [
      {
        id: "series_video",
        url: "https://www.youtube.com/watch?v=33333333333",
        theme: "podcast artis",
        priority: 1,
        status: "queued",
        automation_series: true,
        created_at: "2026-06-01T00:00:00.000Z"
      },
      {
        id: "manual_video",
        url: "https://www.youtube.com/watch?v=44444444444",
        theme: "podcast artis",
        priority: 10,
        status: "queued",
        automation_series: false,
        manual_run: true,
        created_at: "2026-06-01T01:00:00.000Z"
      }
    ]);
    await writeJson("history", []);

    const selection = await selectNextVideo({
      excludeAutomationSeries: true,
      preferredVideoIds: ["manual_video"],
      theme: "auto"
    });
    assert.equal(selection.video.id, "manual_video");
  });
});

test("queue series exposes previous clip ranges for the same source", async () => {
  await withTempData(async () => {
    const video = {
      id: "video_1",
      url: "https://www.youtube.com/watch?v=11111111111",
      youtube_video_id: "11111111111",
      automation_series: true,
      series_target_count: 3
    };

    await writeJson("history", [
      {
        status: "published",
        queue_series: true,
        video_id: "video_1",
        source_youtube_video_id: "11111111111",
        start_time: 80,
        end_time: 132.5,
        duration: 52.5
      },
      {
        status: "published",
        queue_series: true,
        video_id: "other_video",
        source_youtube_video_id: "22222222222",
        start_time: 20,
        end_time: 70
      },
      {
        status: "publish_failed",
        queue_series: true,
        video_id: "video_1",
        source_youtube_video_id: "11111111111",
        start_time: 150,
        end_time: 205
      }
    ]);

    const ranges = await queueSeriesClipRanges(video);
    assert.deepEqual(ranges.map(({ start, end, duration }) => ({ start, end, duration })), [
      { start: 80, end: 132.5, duration: 52.5 }
    ]);
  });
});

test("storedSeriesClipRanges reads the authoritative ledger from the video record", async () => {
  const { storedSeriesClipRanges } = await import("../src/queue-policy.js");
  const video = {
    id: "video_1",
    automation_series: true,
    series_clip_ranges: [
      { start: 100.123, end: 152.5 },
      { start: -5, end: 10 },
      { start: 50, end: 50 },
      { start: 200, end: 260 }
    ]
  };

  assert.deepEqual(storedSeriesClipRanges(video), [
    { start: 100.12, end: 152.5 },
    { start: 200, end: 260 }
  ]);
  assert.deepEqual(storedSeriesClipRanges({}), []);
});

test("dedupeClipRanges removes overlapping duplicates and invalid ranges", async () => {
  const { dedupeClipRanges } = await import("../src/queue-policy.js");
  const merged = dedupeClipRanges([
    { start: 100, end: 152 },
    { start: 100.2, end: 152.4 },
    { start: 200, end: 260 },
    { start: 300, end: 200 }
  ]);

  assert.deepEqual(merged, [
    { start: 100, end: 152 },
    { start: 200, end: 260 }
  ]);
});

test("seriesClipsForRun renders the full target when fresh and only the remainder afterwards", async () => {
  const { seriesClipsForRun } = await import("../src/queue-policy.js");

  // Fresh link: render all 3 clips in one run.
  assert.equal(seriesClipsForRun({ series_target_count: 3, series_success_count: 0 }), 3);
  // Partial recovery: only 1 clip left after 2 successes.
  assert.equal(seriesClipsForRun({ series_target_count: 3, series_success_count: 2 }), 1);
  // Completed: nothing left to render.
  assert.equal(seriesClipsForRun({ series_target_count: 3, series_success_count: 3 }), 0);
});
