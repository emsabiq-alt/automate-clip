import test from "node:test";
import assert from "node:assert/strict";

// Unit tests for the state merge logic — the core anti-duplicate guard that
// prevents a stale SFTP snapshot from clobbering fresh GitHub-cache progress.

test("series success count never moves backwards when merging local vs remote video records", async () => {
  const { __testables } = await import("../src/state-sync.js");
  const { mergeArrays, mergeStrategies } = __testables;

  // local (cache runner) = progres terbaru: 3 sukses, 3 range.
  const local = [{
    id: "v1",
    updated_at: "2026-06-05T02:00:00.000Z",
    series_success_count: 3,
    series_target_count: 3,
    series_clip_ranges: [{ start: 10, end: 60 }, { start: 100, end: 150 }, { start: 200, end: 250 }]
  }];
  // remote (SFTP basi) = progres lama: 1 sukses, 1 range, timestamp lebih tua.
  const remote = [{
    id: "v1",
    updated_at: "2026-06-05T00:00:00.000Z",
    series_success_count: 1,
    series_target_count: 3,
    series_clip_ranges: [{ start: 10, end: 60 }]
  }];

  const merged = mergeArrays(local, remote, mergeStrategies["videos.json"]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].series_success_count, 3, "success count must not regress");
  assert.equal(merged[0].series_remaining_count, 0);
  assert.equal(merged[0].series_clip_ranges.length, 3, "ledger ranges must be unioned");
});

test("history merge unions entries without dropping local-only records", async () => {
  const { __testables } = await import("../src/state-sync.js");
  const { mergeArrays, mergeStrategies } = __testables;

  const local = [
    { job_id: "J1", clip_index: 1, youtube_video_id: "aaa", recorded_at: "t1" },
    { job_id: "J2", clip_index: 1, youtube_video_id: "bbb", recorded_at: "t2" }
  ];
  const remote = [
    { job_id: "J1", clip_index: 1, youtube_video_id: "aaa", recorded_at: "t1" },
    { job_id: "J0", clip_index: 1, youtube_video_id: "zzz", recorded_at: "t0" }
  ];

  const merged = mergeArrays(local, remote, mergeStrategies["history.json"]);
  const ids = merged.map((e) => e.job_id).sort();
  assert.deepEqual(ids, ["J0", "J1", "J2"], "should union, keeping local-only J2 and adding remote-only J0");
});

test("remote-only video records are still included after merge", async () => {
  const { __testables } = await import("../src/state-sync.js");
  const { mergeArrays, mergeStrategies } = __testables;

  const local = [{ id: "v1", updated_at: "2026-06-05T02:00:00.000Z" }];
  const remote = [
    { id: "v1", updated_at: "2026-06-05T00:00:00.000Z" },
    { id: "v2", updated_at: "2026-06-05T01:00:00.000Z" }
  ];

  const merged = mergeArrays(local, remote, mergeStrategies["videos.json"]);
  const ids = merged.map((v) => v.id).sort();
  assert.deepEqual(ids, ["v1", "v2"]);
});
