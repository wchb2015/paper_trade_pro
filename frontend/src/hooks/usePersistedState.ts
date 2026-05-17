import { useEffect, useState } from "react";

/**
 * Mirror a string-valued state to localStorage. The value is read on first
 * render (synchronously) and written back on every change. Failures (private
 * mode, quota exceeded) are swallowed — persistence is best-effort.
 *
 * Only string types are supported because the existing keys (ptp_theme,
 * ptp_page, ptp_detail) were written without JSON serialization. Adding JSON
 * here would silently break those reads.
 */
export function usePersistedState<T extends string>(
  key: string,
  fallback: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : (v as T);
    } catch (err) {
      console.error(
        `[usePersistedState] ERROR reading "${key}" from localStorage`,
        err,
      );
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      console.error(
        `[usePersistedState] ERROR writing "${key}" to localStorage`,
        err,
      );
    }
  }, [key, value]);

  return [value, setValue];
}
