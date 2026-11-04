/**
 * PII masking before any SQL leaves the process.
 *
 * Same rules, same order and same split as SlashPeak's scan (which masks inside
 * BigQuery with RE2): built-in email, phone and IP patterns, then the account's
 * own patterns from `/v1/config`. Backtick-quoted names are left alone.
 *
 * The patterns run on `re2js` (RE2 in pure JS), the same engine the router
 * uses: same syntax (`(?i)` and friends), ASCII-only `\d`, `\b` and `\s` like
 * BigQuery, and linear time, so no owner pattern can hang the caller.
 */

import { RE2JS } from "re2js";

/** The router's built-in rules (`spec/mask_vectors.json` → `builtinRules`; a test keeps them equal). */
export const BUILTIN_RULES: ReadonlyArray<readonly [pattern: string, token: string]> = [
  ["\\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\b", "<email>"],
  [
    "\\+\\d(?:[-.\\s()]{0,2}\\d){6,14}\\b|(?:\\b1[-.\\s])?(?:\\(\\d{3}\\)[-.\\s]?|\\b\\d{3}[-.\\s])\\d{3}[-.\\s]\\d{4}\\b",
    "<phone>",
  ],
  ["\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b", "<ip>"],
  [
    "\\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,6}(?::[0-9a-fA-F]{1,4}){1,6}\\b" +
      "|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:|::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\\b",
    "<ip>",
  ],
];
export const CUSTOM_TOKEN = "<redacted>";
export const BUILTIN_REVISION = "builtin";

/** Same split as the scan's `REGEXP_EXTRACT_ALL(text, r'`[^`]*`|[^`]+|`')`. */
const SEGMENTS = /`[^`]*`|[^`]+|`/g;

/** A rule does not compile. The caller then sends nothing. */
export class MaskError extends Error {}

export class Masker {
  private readonly rules: ReadonlyArray<{ re: RE2JS; token: string }>;

  constructor(
    rules: Iterable<readonly [string, string]>,
    readonly revision: string
  ) {
    const compiled: Array<{ re: RE2JS; token: string }> = [];
    for (const [pattern, token] of rules) {
      try {
        compiled.push({ re: RE2JS.compile(pattern), token });
      } catch {
        throw new MaskError("mask rule does not compile");
      }
    }
    this.rules = compiled;
  }

  private maskSegment(segment: string): string {
    let text = segment;
    for (const rule of this.rules) {
      // A function replacement: the token is used as written, never read for `$1`.
      text = rule.re.matcher(text).replaceAll(() => rule.token);
    }
    return text;
  }

  mask(text: string): string {
    let out = "";
    for (const match of text.matchAll(SEGMENTS)) {
      const segment = match[0];
      out += segment.length > 1 && segment.startsWith("`") ? segment : this.maskSegment(segment);
    }
    return out;
  }
}

export function builtinMasker(ownerPatterns: readonly string[] = []): Masker {
  return new Masker([...BUILTIN_RULES, ...ownerPatterns.map((p) => [p, CUSTOM_TOKEN] as const)], BUILTIN_REVISION);
}

/** The masker for `/v1/config`'s `mask` block; null when it is missing or malformed. Throws `MaskError`. */
export function maskerFromConfig(mask: unknown): Masker | null {
  if (!isRecord(mask)) return null;
  const { rules, revision } = mask;
  if (!Array.isArray(rules) || typeof revision !== "string") return null;
  const pairs: Array<[string, string]> = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.pattern !== "string" || typeof rule.token !== "string") return null;
    pairs.push([rule.pattern, rule.token]);
  }
  return new Masker(pairs, revision.slice(0, 64));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
