import test from "node:test";
import assert from "node:assert/strict";
import { metaInterClipDelayMs } from "../src/platform-delay.js";

test("Meta delay starts from the second clip only", () => {
  const platforms = { youtube: true, tiktok: true, facebook: true };
  assert.equal(metaInterClipDelayMs({ clipIndex: 1, platforms, configuredSeconds: 75 }), 0);
  assert.equal(metaInterClipDelayMs({ clipIndex: 2, platforms, configuredSeconds: 75 }), 75000);
});

test("Meta delay does not apply when only YouTube and TikTok are selected", () => {
  assert.equal(metaInterClipDelayMs({
    clipIndex: 2,
    platforms: { youtube: true, tiktok: true },
    configuredSeconds: 75
  }), 0);
});
