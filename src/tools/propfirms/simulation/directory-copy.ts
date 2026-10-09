/*
  The simulator's descriptions on the "directory" toolset (auth/surface.ts).
  Claude's directory policy bars tool descriptions that instruct the model
  ("always surface…", "never present…", "relay…"); the same facts, stated as
  what the result carries, read fine to both the model and the reviewers. The
  full toolset keeps the original instructions.

  Applied in order to tool and field descriptions; each pattern matches a
  sentence of the upstream package or of pass-rates.ts / validate-strategy.ts.
*/
const DIRECTORY_EDITS: ReadonlyArray<[RegExp, string]> = [
  [
    / These are material: always surface the flags and the disclaimer to the user alongside the numbers, never just the headline probability\./g,
    " These are material to the numbers.",
  ],
  [/ - relay those to the user next to any numbers/g, ""],
  [/material caveats to relay to the user/g, "material caveats"],
  [
    /; relay them and treat the firm's page as authoritative\./g,
    "; the firm's page is authoritative.",
  ],
  [/, and none should be presented/g, ""],
  [
    /Never present one number as THE optimal risk; report both optima and the trade-off, and let the user choose\./g,
    "Neither is THE optimal risk on its own: the result reports both optima and the trade-off between them.",
  ],
  [
    /, and results should be presented that way \('best EV for these inputs', never 'best firm'\)/g,
    "",
  ],
  [/ that must be relayed verbatim/g, ""],
  [/ that MUST be relayed to the user/g, ""],
  [
    /Include the seed and path count when reporting numbers so users can reproduce them exactly; re-run with a few different seeds to gauge Monte Carlo spread\./g,
    "Results carry the seed and path count, so they reproduce exactly; different seeds show the Monte Carlo spread.",
  ],
  [
    /so prefer measured stats over self-reported ones/g,
    "so measured stats are more reliable than self-reported ones",
  ],
  [/ — always relay inferred fields\)/g, ")"],
  [/; always state the bar when relaying results/g, ""],
  [/ State the bar when relaying results\./g, ""],
  [/, so relay flags\./g, "."],
];

export function directoryCopy(text: string): string {
  return DIRECTORY_EDITS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}
