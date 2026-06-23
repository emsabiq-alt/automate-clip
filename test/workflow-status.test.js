import test from "node:test";
import assert from "node:assert/strict";
import { finalStatusFromClipResults } from "../src/workflow.js";

test("finalStatusFromClipResults keeps non-publish runs ready to publish", () => {
  const final = finalStatusFromClipResults([
    { ok: true, primaryPublished: false, platformResults: null }
  ], false);

  assert.equal(final.status, "ready_to_publish");
  assert.equal(final.publishStatus, "ready_to_publish");
  assert.equal(final.publishedClips, 0);
});

test("finalStatusFromClipResults defers on YouTube quota without marking failed", () => {
  const final = finalStatusFromClipResults([
    {
      ok: true,
      primaryPublished: false,
      platformResults: {
        hasErrors: true,
        quotaExceeded: { youtube: true }
      }
    }
  ], true);

  assert.equal(final.status, "queued");
  assert.equal(final.publishStatus, "queued");
  assert.equal(final.event, "youtube_quota_deferred");
});
