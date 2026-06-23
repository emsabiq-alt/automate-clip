import test from "node:test";
import assert from "node:assert/strict";
import { parseBoolConfigValue, parseNumberConfigValue } from "../src/config.js";

test("config-style boolean parsing matches env conventions", () => {
  assert.equal(parseBoolConfigValue(undefined, true), true);
  assert.equal(parseBoolConfigValue("", true), true);
  assert.equal(parseBoolConfigValue("1"), true);
  assert.equal(parseBoolConfigValue("true"), true);
  assert.equal(parseBoolConfigValue("yes"), true);
  assert.equal(parseBoolConfigValue("on"), true);
  assert.equal(parseBoolConfigValue("0"), false);
  assert.equal(parseBoolConfigValue("false"), false);
});

test("config-style number parsing keeps finite values and falls back otherwise", () => {
  assert.equal(parseNumberConfigValue("42", 10), 42);
  assert.equal(parseNumberConfigValue("1.5", 10), 1.5);
  assert.equal(parseNumberConfigValue("not-a-number", 10), 10);
  assert.equal(parseNumberConfigValue(undefined, 10), 10);
});
