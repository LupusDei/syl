import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CSS_VARIABLE_NAMES,
  DEFAULT_THEME,
  THEMES,
  THEME_NAMES,
  isThemeName,
  token,
} from "../../src/theme/tokens";

const css = readFileSync(new URL("../../src/theme/tokens.css", import.meta.url), "utf8");

/** Every `--syl-*` custom property this stylesheet declares (not references). */
const declaredInCss = new Set(
  [...css.matchAll(/^\s*(--syl-[a-z0-9-]+)\s*:/gm)].map((match) => match[1] as string),
);

describe("theme registry", () => {
  it("should describe every name in THEME_NAMES", () => {
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_NAMES].sort());
  });

  it("should default to a theme that actually exists", () => {
    expect(THEME_NAMES).toContain(DEFAULT_THEME);
  });

  it("should give every theme a label and a colour scheme", () => {
    for (const name of THEME_NAMES) {
      const theme = THEMES[name];
      expect(theme.label.length).toBeGreaterThan(0);
      expect(["dark", "light"]).toContain(theme.colorScheme);
    }
  });

  it("should carry no colour values in TypeScript — the palette lives in CSS", () => {
    // The whole point of the token indirection: swapping a palette must never
    // require a rebuild of the component tree.
    expect(JSON.stringify(THEMES)).not.toMatch(/#[0-9a-f]{3}|rgb\(|hsl\(/i);
  });
});

describe("isThemeName", () => {
  it("should accept a known theme", () => {
    expect(isThemeName(DEFAULT_THEME)).toBe(true);
  });

  it("should reject an unknown string", () => {
    expect(isThemeName("phosphor")).toBe(false);
  });

  it("should reject a non-string", () => {
    expect(isThemeName(null)).toBe(false);
  });
});

describe("semantic tokens", () => {
  it("should reference every token as a CSS custom property", () => {
    for (const [name, reference] of Object.entries(token)) {
      expect(reference, `token ${name}`).toMatch(/^var\(--syl-[a-z0-9-]+\)$/);
    }
  });

  it("should list each variable exactly once in CSS_VARIABLE_NAMES", () => {
    expect(new Set(CSS_VARIABLE_NAMES).size).toBe(CSS_VARIABLE_NAMES.length);
  });

  it("should declare every referenced variable in the stylesheet", () => {
    const missing = CSS_VARIABLE_NAMES.filter((name) => !declaredInCss.has(name));
    expect(missing).toEqual([]);
  });

  it("should declare no variable the TypeScript map does not know about", () => {
    const known = new Set<string>(CSS_VARIABLE_NAMES);
    const orphans = [...declaredInCss].filter((name) => !known.has(name));
    expect(orphans).toEqual([]);
  });
});

describe("theme stylesheet", () => {
  it("should carry a selector block for every registered theme", () => {
    for (const name of THEME_NAMES) {
      expect(css).toContain(`[data-theme="${name}"]`);
    }
  });

  it("should define the full token set at :root, so an unstamped document still renders", () => {
    const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
    const missing = CSS_VARIABLE_NAMES.filter((name) => !rootBlock.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});
