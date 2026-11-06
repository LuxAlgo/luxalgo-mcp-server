/*
  Plain-language result text for the simulator tools, off the Claude address
  (_shared/surface.ts keeps that one as reviewed). Applied to the upstream
  package's result prose (package-tools.ts) and used by the two local tools
  (pass-rates.ts, validate-strategy.ts). Numbers and structured content are
  never touched: only how the text says them.

    - results state facts, not instructions to the model: "relay these to the
      user", "present both to the user" and the like are dropped or restated;
    - a challenge label never repeats its firm ("FTMO - FTMO - Normal …"):
      directory challenge names already start with the firm's name;
    - a fee refunded on a pass is said in words. "expected total cost: €5" for
      a €540 challenge is correct (one refunded fee per funded path) but reads
      like a bug; "Fee €540 per attempt, refunded on a pass; average cost across
      attempts €5" does not.
*/

/** Same rendering as the upstream package: whole units in the currency's own style. */
export function fmtCurrency(amount: number, currency: string): string {
  const rounded = Math.round(amount);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(rounded);
  } catch {
    return `${rounded.toLocaleString("en-US")} ${currency}`;
  }
}

export type FeeTerms = {
  price: number;
  billing?: string;
  activationFee?: number;
  refundableOnPass?: boolean;
};

/** "Fee €540 per attempt, refunded on a pass" — the fee as the trader reads it. */
export function feeWords(fees: FeeTerms, currency: string): string {
  const monthly = fees.billing === "monthly";
  return (
    `Fee ${fmtCurrency(fees.price, currency)} ${monthly ? "a month" : "per attempt"}` +
    ((fees.activationFee ?? 0) > 0 ? `, plus ${fmtCurrency(fees.activationFee ?? 0, currency)} on activation` : "") +
    (fees.refundableOnPass && !monthly ? ", refunded on a pass" : "")
  );
}

/** "Alpha Capital - Alpha Capital - Pro 10K" → "Alpha Capital - Pro 10K"; a label without the repeat is unchanged. */
export function withoutRepeatedFirm(label: string, firmName: string | null | undefined): string {
  if (!firmName) return label;
  const prefix = `${firmName} - `;
  return label.startsWith(prefix + prefix) ? label.slice(prefix.length) : label;
}

/** A challenge name without its leading "<firm> - ", for rows that already name the firm. */
export function challengeNameWithoutFirm(name: string, firmName: string | null | undefined): string {
  if (!firmName) return name;
  const prefix = `${firmName} - `;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

/* Upstream sentences that address the model, and their factual form. */
const INSTRUCTION_EDITS: ReadonlyArray<[RegExp, string]> = [
  [/^Assumptions \((\d+) flags - relay these to the user\): /gm, "Assumptions ($1 flags): "],
  [
    / Present both to the user - choosing between them is a preference /g,
    " Choosing between them is a preference ",
  ],
  [
    /Challenges with more unsimulated flags have optimistic numbers - compare flags alongside EV\. Run (\w+) on interesting rows for full detail\./g,
    "Challenges with more unsimulated flags have optimistic numbers. $1 gives full detail on any row.",
  ],
  // Comparison rows: the same journey cost, named for what it is.
  [/, expected attempts ([\d.]+), expected cost /g, ", expected attempts $1, average cost across attempts "],
];

/** "FTMO - FTMO - Normal …" at the start of a line, after "Risk sweep for " or a list number. */
const REPEATED_FIRM = /(^|\n|Risk sweep for |\n\d+\. )([^\n]{1,80}?) - \2 - /g;

const COST_SEGMENT = /expected total cost: ([^|\n(]+?)(?: \(given funded: ([^)\n]+)\))?(?=$|\n| \|)/;

type SimStructured = {
  assumptions?: { spec?: { currency?: string; fees?: FeeTerms } };
};

/**
 * The package tools' result text, restated for the open addresses. `structured`
 * is the result's structuredContent: a simulation result carries its encoded
 * spec, whose fees turn the cost line into words.
 */
export function plainResultText(text: string, structured: unknown): string {
  let out = INSTRUCTION_EDITS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
  out = out.replace(REPEATED_FIRM, "$1$2 - ");
  const spec = (structured as SimStructured | null | undefined)?.assumptions?.spec;
  if (spec?.fees && typeof spec.fees.price === "number") {
    const currency = spec.currency ?? "USD";
    out = out.replace(COST_SEGMENT, (_match, cost: string, givenFunded: string | undefined) => {
      const average = `average cost across attempts ${cost.trim()}`;
      const funded = givenFunded ? ` (${givenFunded.trim()} on paths that get funded)` : "";
      return `${feeWords(spec.fees!, currency)}; ${average}${funded}`;
    });
  }
  return out;
}
