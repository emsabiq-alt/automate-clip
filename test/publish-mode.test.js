import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSafePublishMode,
  platformAllowedBySafeMode,
  selectPublishPlatforms
} from "../src/publish-mode.js";

const allEnabled = {
  youtube: true,
  facebook: true,
  instagram: true,
  tiktok: true,
  threads: true
};

test("safe publish mode defaults to all for empty or invalid values", () => {
  assert.equal(parseSafePublishMode(""), "all");
  assert.equal(parseSafePublishMode(undefined), "all");
  assert.equal(parseSafePublishMode("bad-value"), "all");
  assert.equal(parseSafePublishMode("SOCIAL_ONLY"), "social_only");
});

test("safe publish mode narrows platform selection without enabling disabled platforms", () => {
  assert.deepEqual(selectPublishPlatforms(allEnabled, "youtube_only").platforms, {
    youtube: true,
    facebook: false,
    instagram: false,
    tiktok: false,
    threads: false
  });

  assert.deepEqual(selectPublishPlatforms({
    youtube: false,
    facebook: true,
    instagram: false,
    tiktok: true,
    threads: false
  }, "social_only").platforms, {
    youtube: false,
    facebook: true,
    instagram: false,
    tiktok: true,
    threads: false
  });

  assert.equal(selectPublishPlatforms(allEnabled, "none").hasSelectedPlatform, false);
  assert.equal(platformAllowedBySafeMode("youtube", "social_only"), false);
});
