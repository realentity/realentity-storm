import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { nextPreference, useTheme, type ThemePreference } from "../lib/theme";

const SHOWN: Record<ThemePreference, { icon: typeof IconSun; label: string }> = {
  system: { icon: IconDeviceDesktop, label: "Theme: as the system" },
  light: { icon: IconSun, label: "Theme: light" },
  dark: { icon: IconMoon, label: "Theme: dark" },
};

/** One button: system → light → dark. The icon shows the current choice. */
export function ThemeSwitch() {
  const { preference, choose } = useTheme();
  const { icon: Icon, label } = SHOWN[preference];
  const next = SHOWN[nextPreference(preference)].label.replace("Theme: ", "");
  return (
    <button
      type="button"
      className="btn btn-ghost-secondary btn-icon"
      title={`${label} (click for ${next})`}
      aria-label={`${label}; click for ${next}`}
      data-testid="theme-switch"
      onClick={() => choose(nextPreference(preference))}
    >
      <Icon size={18} />
    </button>
  );
}
