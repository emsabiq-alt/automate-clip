import test from "node:test";
import assert from "node:assert/strict";

import {
  selectThumbnailFrame,
  thumbnailSeekCandidates
} from "../src/thumbnail.js";

test("thumbnail candidates start at the middle and stay around it", () => {
  const candidates = thumbnailSeekCandidates(100);

  assert.equal(candidates[0].seconds, 50);
  assert.deepEqual(
    candidates.map((candidate) => candidate.ratio),
    [0.5, 0.44, 0.56, 0.38, 0.62]
  );
});

test("thumbnail selection avoids a dark middle frame", () => {
  const selected = selectThumbnailFrame([
    { seconds: 50, ratio: 0.5, luma: 5 },
    { seconds: 44, ratio: 0.44, luma: 92 },
    { seconds: 56, ratio: 0.56, luma: 74 }
  ], 28);

  assert.equal(selected.seconds, 44);
});

test("thumbnail selection keeps a readable middle frame when scores are close", () => {
  const selected = selectThumbnailFrame([
    { seconds: 50, ratio: 0.5, luma: 80 },
    { seconds: 44, ratio: 0.44, luma: 80.4 }
  ], 28);

  assert.equal(selected.seconds, 50);
});

test("thumbnail candidates reject videos that are too short for multi-frame scoring", () => {
  assert.deepEqual(thumbnailSeekCandidates(2), []);
});
