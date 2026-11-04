import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILTIN_RULES, builtinMasker, CUSTOM_TOKEN, Masker, MaskError, maskerFromConfig } from "../src/core/mask.js";
import { VERSION } from "../src/version.js";
import { loadSpec } from "./helpers.js";

const VECTORS = loadSpec("mask_vectors.json");

test("built-in rules match the router's", () => {
  assert.deepEqual(
    BUILTIN_RULES.map(([pattern, token]) => ({ pattern, token })),
    VECTORS.builtinRules
  );
  assert.equal(CUSTOM_TOKEN, VECTORS.customToken);
});

test("shared vectors", () => {
  for (const vector of VECTORS.vectors) {
    assert.equal(builtinMasker(vector.patterns ?? []).mask(vector.sql), vector.masked, JSON.stringify(vector.sql));
  }
});

test("masking masked text changes nothing", () => {
  const masker = builtinMasker(["ACCT-\\d+"]);
  for (const vector of VECTORS.vectors) {
    const once = masker.mask(vector.sql);
    assert.equal(masker.mask(once), once);
  }
});

test("config rules are used in order, tokens as written", () => {
  const masker = maskerFromConfig({
    revision: "r7",
    rules: [
      { pattern: "a+", token: "$1" },
      { pattern: "\\$1", token: "<x>" },
    ],
  })!;
  assert.equal(masker.revision, "r7");
  assert.equal(masker.mask("caab"), "c<x>b");
});

test("a bad rule throws; a bad block is null", () => {
  assert.throws(() => new Masker([["(", "<x>"]], "r"), MaskError);
  assert.throws(() => maskerFromConfig({ revision: "r", rules: [{ pattern: "(?<=a)b", token: "<x>" }] }), MaskError);
  assert.equal(maskerFromConfig(null), null);
  assert.equal(maskerFromConfig({ rules: [] }), null);
  assert.equal(maskerFromConfig({ revision: "r", rules: [{ pattern: 1, token: "x" }] }), null);
});

test("RE2 syntax: inline flags work, Unicode digits are not digits", () => {
  assert.equal(builtinMasker(["(?i)acct-\\d+"]).mask("ACCT-9"), CUSTOM_TOKEN);
  // Arabic-Indic digits: RE2's \d is ASCII-only, like BigQuery.
  assert.equal(builtinMasker().mask("+٤٤ ٢٠ ٧٩٤٦ ٠٩٥٨"), "+٤٤ ٢٠ ٧٩٤٦ ٠٩٥٨");
});

test("VERSION equals package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});
