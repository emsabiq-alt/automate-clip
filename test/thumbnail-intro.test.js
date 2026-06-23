import test from "node:test";
import assert from "node:assert/strict";
import { thumbnailIntroVisualMode } from "../src/thumbnail.js";

test("thumbnail intro uses the generated thumbnail by default", () => {
  assert.equal(thumbnailIntroVisualMode(undefined), "thumbnail");
});

test("thumbnail intro can explicitly fall back to a video freeze frame", () => {
  assert.equal(thumbnailIntroVisualMode("false"), "video");
  assert.equal(thumbnailIntroVisualMode("true"), "thumbnail");
});
