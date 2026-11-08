import { useCallback, useEffect, useState } from "react";

/**
 * Light or dark, or whatever the system says. The choice is kept in this browser (localStorage, key THEME_KEY) and
 * applied as Tabler's `data-bs-theme` on <html>. public/theme-init.js applies it before the first paint (no flash of
 * light); keep the key and the values the same there.
 */
export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "theme";
const ORDER: ThemePreference[] = ["system", "light", "dark"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parsePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** The switch cycles: system → light → dark → system. */
export function nextPreference(preference: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
}

function readPreference(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function savePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
}

function systemDark() {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

function apply(preference: ThemePreference) {
  document.documentElement.setAttribute("data-bs-theme", resolveTheme(preference, systemDark()));
}

/** The current preference and a setter; follows the system while the preference is "system". */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    apply(preference);
    if (preference !== "system" || !window.matchMedia) return;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => apply("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [preference]);

  const choose = useCallback((next: ThemePreference) => {
    savePreference(next);
    setPreference(next);
  }, []);

  return { preference, choose };
}
