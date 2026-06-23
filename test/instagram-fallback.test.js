import test from "node:test";
import assert from "node:assert/strict";
import { isInstagramUserAccessRestricted } from "../src/instagram.js";

test("detects Meta Instagram user access restrictions", () => {
  assert.equal(isInstagramUserAccessRestricted({ apiSubcode: 2207050 }), true);
  assert.equal(isInstagramUserAccessRestricted(new Error("User access is restricted")), true);
  assert.equal(isInstagramUserAccessRestricted(new Error("Media upload failed")), false);
});
