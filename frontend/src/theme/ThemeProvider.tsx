import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { defaultStorage, type StorageLike } from "../storage";
import {
  DEFAULT_THEME,
  THEMES,
  THEME_LIST,
  isThemeName,
  type ThemeDescriptor,
  type ThemeName,
} from "./tokens";

export const THEME_STORAGE_KEY = "syl.admin.theme";

export interface ThemeContextValue {
  readonly theme: ThemeName;
  readonly themes: readonly ThemeDescriptor[];
  setTheme(name: ThemeName): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Injectable so tests never touch the real `localStorage`. */
  storage?: StorageLike | undefined;
  /** Where `data-theme` is stamped. Defaults to `<html>`. */
  target?: HTMLElement | undefined;
}

/**
 * Holds the selected theme and stamps it onto the DOM.
 *
 * The context carries the *name*, not the values: components read colours
 * through `var(--syl-…)`, so a palette swap is a single attribute write and
 * costs no re-render of the tree below.
 */
export function ThemeProvider({ children, storage, target }: ThemeProviderProps): ReactElement {
  const store = useMemo(() => storage ?? defaultStorage(), [storage]);

  const [theme, setThemeState] = useState<ThemeName>(() => {
    // A theme that was renamed or removed since the operator last visited must
    // not wedge the app on a palette that no longer exists.
    const stored = store.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : DEFAULT_THEME;
  });

  useEffect(() => {
    const element = target ?? document.documentElement;
    element.setAttribute("data-theme", theme);
    element.style.colorScheme = THEMES[theme].colorScheme;
  }, [theme, target]);

  const setTheme = useCallback(
    (name: ThemeName): void => {
      setThemeState(name);
      store.setItem(THEME_STORAGE_KEY, name);
    },
    [store],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, themes: THEME_LIST, setTheme }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme() must be called inside a <ThemeProvider>.");
  }
  return value;
}
