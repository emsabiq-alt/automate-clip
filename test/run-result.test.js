import test from "node:test";
import assert from "node:assert/strict";
import { isWorkflowFailureResult } from "../src/run-result.js";

test("queue exhaustion fails the workflow command", () => {
  assert.equal(isWorkflowFailureResult({ status: "queue_failed" }), true);
});

test("no selection only fails after source processing errors", () => {
  assert.equal(isWorkflowFailureResult({
    status: "no_video_selected",
    skipped_failed_video_count: 2
  }), true);
  assert.equal(isWorkflowFailureResult({
    status: "no_video_selected",
    skipped_failed_video_count: 0
  }), false);
});
