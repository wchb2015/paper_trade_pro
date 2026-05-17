import { Icon } from "./Icon";
import type { Theme, Tweaks } from "../lib/types";

interface TweaksPanelProps {
  tweaks: Tweaks;
  setTweaks: React.Dispatch<React.SetStateAction<Tweaks>>;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onClose: () => void;
}

const ACCENT_SWATCHES = [
  "#4f46e5",
  "#0ea5e9",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#111111",
];

export function TweaksPanel({
  tweaks,
  setTweaks,
  theme,
  setTheme,
  onClose,
}: TweaksPanelProps) {
  const setTweak = <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => {
    setTweaks((prev) => ({ ...prev, [k]: v }));
  };

  return (
    <div className="tweaks-panel">
      <div className="tweaks-header">
        <span>Tweaks</span>
        <button className="btn ghost icon-only" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="tweaks-body">
        <div className="tweaks-row">
          <label className="label">Accent color</label>
          <div style={{ display: "flex", gap: 6 }}>
            {ACCENT_SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => setTweak("accent", c)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: c,
                  border:
                    tweaks.accent === c
                      ? "2px solid var(--text)"
                      : "2px solid var(--border)",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </div>
        <div className="tweaks-row">
          <label className="label">Gain / Loss palette</label>
          <div
            className="segmented"
            style={{ display: "flex", width: "100%" }}
          >
            <button
              className={tweaks.gainColor === "#059669" ? "active" : ""}
              style={{ flex: 1 }}
              onClick={() => {
                setTweak("gainColor", "#059669");
                setTweak("lossColor", "#e11d48");
              }}
            >
              Green / Red
            </button>
            <button
              className={tweaks.gainColor === "#2563eb" ? "active" : ""}
              style={{ flex: 1 }}
              onClick={() => {
                setTweak("gainColor", "#2563eb");
                setTweak("lossColor", "#ea580c");
              }}
            >
              Blue / Orange
            </button>
          </div>
        </div>
        <div className="tweaks-row">
          <label className="label">Theme</label>
          <div
            className="segmented"
            style={{ display: "flex", width: "100%" }}
          >
            <button
              className={theme === "light" ? "active" : ""}
              style={{ flex: 1 }}
              onClick={() => setTheme("light")}
            >
              Light
            </button>
            <button
              className={theme === "dark" ? "active" : ""}
              style={{ flex: 1 }}
              onClick={() => setTheme("dark")}
            >
              Dark
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
