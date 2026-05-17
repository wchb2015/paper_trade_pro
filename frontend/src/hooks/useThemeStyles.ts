import { useEffect } from "react";
import type { Theme, Tweaks } from "../lib/types";

/**
 * Drive the document-root style attributes from theme + tweaks. Sets
 * data-theme (light/dark) and the --accent / --up / --down CSS variables
 * consumed by the stylesheet.
 */
export function useThemeStyles(theme: Theme, tweaks: Tweaks): void {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--accent", tweaks.accent);
    r.setProperty("--up", tweaks.gainColor);
    r.setProperty("--down", tweaks.lossColor);
  }, [tweaks]);
}
