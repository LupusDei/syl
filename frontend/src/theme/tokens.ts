/**
 * The design-token registry.
 *
 * Two rules make this worth having:
 *
 * 1. **No colour value appears in TypeScript.** Every token here is a
 *    *reference* — `var(--syl-bg-panel)` — and the values live in `tokens.css`,
 *    swapped by a `data-theme` attribute. Changing the palette is a stylesheet
 *    edit, not a re-render.
 * 2. **The reference map is the contract.** `tokens.test.ts` fails if a token
 *    named here is missing from the stylesheet, or if the stylesheet declares
 *    a `--syl-*` variable nobody references. Tokens cannot rot in either
 *    direction.
 *
 * Adding a theme is: extend `THEME_NAMES`, add a row to `THEMES`, add one
 * `[data-theme="…"]` block to `tokens.css`.
 */

export const THEME_NAMES = ["instrument", "paper"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export interface ThemeDescriptor {
  readonly name: ThemeName;
  /** Shown in the palette picker. */
  readonly label: string;
  /** Drives the native `color-scheme` property, so form controls follow suit. */
  readonly colorScheme: "dark" | "light";
}

export const THEMES: Record<ThemeName, ThemeDescriptor> = {
  instrument: { name: "instrument", label: "Instrument", colorScheme: "dark" },
  paper: { name: "paper", label: "Paper", colorScheme: "light" },
};

export const THEME_LIST: readonly ThemeDescriptor[] = THEME_NAMES.map((name) => THEMES[name]);

export const DEFAULT_THEME: ThemeName = "instrument";

export function isThemeName(value: unknown): value is ThemeName {
  // Safe: widening a `readonly ThemeName[]` to `readonly string[]` so
  // `includes` accepts an arbitrary string. It loosens the argument type only;
  // the narrowing is done by the `value is ThemeName` return type.
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

/**
 * Semantic tokens. Components reference these and never a raw colour — that is
 * what keeps a palette swap from turning into a component audit.
 */
export const token = {
  bgBase: "var(--syl-bg-base)",
  bgPanel: "var(--syl-bg-panel)",
  bgRaised: "var(--syl-bg-raised)",
  bgInset: "var(--syl-bg-inset)",

  textPrimary: "var(--syl-text-primary)",
  textSecondary: "var(--syl-text-secondary)",
  textMuted: "var(--syl-text-muted)",
  textInverse: "var(--syl-text-inverse)",

  border: "var(--syl-border)",
  borderStrong: "var(--syl-border-strong)",

  accent: "var(--syl-accent)",
  accentContrast: "var(--syl-accent-contrast)",
  accentSoft: "var(--syl-accent-soft)",

  stateOk: "var(--syl-state-ok)",
  stateWarn: "var(--syl-state-warn)",
  stateFail: "var(--syl-state-fail)",
  statePending: "var(--syl-state-pending)",

  fontUi: "var(--syl-font-ui)",
  fontMono: "var(--syl-font-mono)",
  textSize: "var(--syl-text-size)",
  textSizeSmall: "var(--syl-text-size-small)",
  lineHeight: "var(--syl-line-height)",

  space1: "var(--syl-space-1)",
  space2: "var(--syl-space-2)",
  space3: "var(--syl-space-3)",
  space4: "var(--syl-space-4)",
  space5: "var(--syl-space-5)",

  radius: "var(--syl-radius)",
  borderWidth: "var(--syl-border-width)",
  focusRing: "var(--syl-focus-ring)",
  shadowPanel: "var(--syl-shadow-panel)",
} as const;

export type SemanticToken = keyof typeof token;

/** The bare custom-property names, e.g. `--syl-bg-base`. Used by the contract test. */
export const CSS_VARIABLE_NAMES: readonly string[] = Object.values(token).map((reference) =>
  reference.slice("var(".length, -1),
);
