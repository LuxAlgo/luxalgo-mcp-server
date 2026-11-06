/*
  Natural challenge queries for propfirms_search_challenges.

  The app's `text` filter is a plain case-insensitive substring match over
  the challenge name and the firm's name and slug, so the way people (and
  models) actually ask — "FTMO 100K", "FTMO 2-step 100k", "the 5ers 2 step"
  — matches nothing: no challenge name contains "ftmo 100k". When a text
  search comes back empty, the query is read as what it says: an account
  size (100k, 12.5K, 1M, 100000, 100,000), a step count (2-step, two phase,
  instant) and a firm, and those are mapped onto the route's EXISTING
  structured filters (accountSizeMin/Max, steps, propfirmId, challengeName).
  The rows are therefore exactly what those filters return; nothing is
  ranked or filtered here.

  Pure functions only; the tool layer (directory-tools.ts) does the calls.
*/
import { normalizeName } from "./simulation/shared.js";

export type ParsedChallengeText = {
  /** Exact account size the text names, e.g. 100000 for "100k". */
  accountSize?: number;
  /** Evaluation step count the text names (0 = instant funding). */
  steps?: number;
  /** What is left once size and steps are taken out (firm and challenge words). */
  rest: string;
};

const STEP_WORDS: Record<string, number> = { one: 1, single: 1, two: 2, three: 3, four: 4 };

const STEPS_PATTERN = /(?<![\w.])(\d|one|single|two|three|four)[\s-]*(?:steps?|phases?|stages?)(?![a-z0-9])/i;
const INSTANT_PATTERN = /(?<![\w.])instant(?:[\s-]*fund(?:ed|ing)?)?(?![a-z0-9])/i;
const SIZE_SUFFIX_PATTERN = /(?<![\w.])\$?(\d+(?:\.\d+)?)\s?([km])(?![a-z0-9])/i;
const SIZE_PLAIN_PATTERN = /(?<![\w.,])\$?(\d{1,3}(?:,\d{3})+|\d{4,8})(?![\w.,])/;

/** Splits a free-text challenge query into account size, step count and the rest. */
export function parseChallengeText(text: string): ParsedChallengeText {
  let rest = ` ${text} `;
  const parsed: ParsedChallengeText = { rest: "" };

  const stepsMatch = STEPS_PATTERN.exec(rest);
  if (stepsMatch) {
    const word = stepsMatch[1]!.toLowerCase();
    parsed.steps = STEP_WORDS[word] ?? Number(word);
    rest = rest.replace(stepsMatch[0], " ");
  } else {
    const instantMatch = INSTANT_PATTERN.exec(rest);
    if (instantMatch) {
      parsed.steps = 0;
      rest = rest.replace(instantMatch[0], " ");
    }
  }

  const suffixMatch = SIZE_SUFFIX_PATTERN.exec(rest);
  if (suffixMatch) {
    const multiplier = suffixMatch[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000;
    parsed.accountSize = Math.round(Number(suffixMatch[1]) * multiplier);
    rest = rest.replace(suffixMatch[0], " ");
  } else {
    const plainMatch = SIZE_PLAIN_PATTERN.exec(rest);
    const value = plainMatch ? Number(plainMatch[1]!.replace(/,/g, "")) : NaN;
    if (plainMatch && value >= 1_000) {
      parsed.accountSize = value;
      rest = rest.replace(plainMatch[0], " ");
    }
  }

  parsed.rest = rest
    .replace(/\s+[-–—/,]+\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—/,]+|[-–—/,]+$/g, "")
    .trim();
  return parsed;
}

export type FirmRef = { propfirmId: string; name: string };

export type FirmMatch = {
  /** Firms the words name (several when a prefix such as "alpha" fits more than one). */
  firms: FirmRef[];
  /** The words that were not part of the firm's name, e.g. "swing" in "ftmo swing". */
  leftover: string;
};

function firmKeys(firm: FirmRef): string[] {
  const keys = new Set([normalizeName(firm.name), normalizeName(firm.propfirmId)]);
  for (const key of [...keys]) if (key.startsWith("the") && key.length > 6) keys.add(key.slice(3));
  return [...keys].filter(Boolean);
}

/**
 * Finds the firm a query names among the directory's firms: the longest run
 * of words whose letters and digits equal a firm's name or slug ("the 5ers",
 * "funding pips", "blue guardian futures"), else the longest run of at
 * least four characters that starts one ("apex" → Apex Trader Funding).
 * Null when no firm fits, so an unknown firm is never mapped onto a wrong one.
 */
export function matchFirms(rest: string, firms: readonly FirmRef[]): FirmMatch | null {
  const words = rest.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;
  const keyed = firms.map((firm) => ({ firm, keys: firmKeys(firm) }));

  for (const mode of ["exact", "prefix"] as const) {
    for (let length = Math.min(words.length, 4); length >= 1; length--) {
      for (let start = 0; start + length <= words.length; start++) {
        const span = words.slice(start, start + length).join("");
        if (mode === "prefix" && span.length < 4) continue;
        const hits = keyed
          .filter(({ keys }) => keys.some((key) => (mode === "exact" ? key === span : key.startsWith(span))))
          .map(({ firm }) => firm);
        if (hits.length > 0) {
          const leftover = [...words.slice(0, start), ...words.slice(start + length)].join(" ");
          return { firms: hits, leftover };
        }
      }
    }
  }
  return null;
}

/** 100000 → "100K", 12500 → "12.5K", 1000000 → "1M". */
export function formatAccountSize(size: number): string {
  if (size >= 1_000_000 && size % 100_000 === 0) return `${size / 1_000_000}M`;
  if (size >= 1_000 && size % 100 === 0) return `${size / 1_000}K`;
  return String(size);
}

export function formatSteps(steps: number): string {
  return steps === 0 ? "instant" : `${steps}-step`;
}

/**
 * One line per firm listing what it does offer, grouped by step count, e.g.
 * "FTMO (ftmo): 1-step 10K, 25K, 50K, 100K, 200K; 2-step 10K, 25K, 50K, 100K, 200K".
 */
export function describeOfferedChallenges(
  challenges: ReadonlyArray<{ propfirmId: string; propfirmName: string; steps: number; accountSize: number }>,
): string[] {
  const byFirm = new Map<string, { name: string; bySteps: Map<number, Set<number>> }>();
  for (const challenge of challenges) {
    const firm = byFirm.get(challenge.propfirmId) ?? { name: challenge.propfirmName, bySteps: new Map() };
    byFirm.set(challenge.propfirmId, firm);
    const sizes = firm.bySteps.get(challenge.steps) ?? new Set<number>();
    firm.bySteps.set(challenge.steps, sizes);
    sizes.add(challenge.accountSize);
  }
  return [...byFirm.entries()].map(([slug, { name, bySteps }]) => {
    const groups = [...bySteps.entries()]
      .sort(([a], [b]) => a - b)
      .map(
        ([steps, sizes]) =>
          `${formatSteps(steps)} ${[...sizes]
            .sort((a, b) => a - b)
            .map(formatAccountSize)
            .join(", ")}`,
      );
    return `${name} (${slug}): ${groups.join("; ")}`;
  });
}
