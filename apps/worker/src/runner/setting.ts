/**
 * M63: a setting of Settings (a run limit), fixed (tests) or looked up when it is needed, for the user whose work it is
 * (without one: the single user's), so a change applies from the next step on without a restart.
 */
export type Setting<T> = T | ((userId?: string) => Promise<T>);

export async function settingOf<T>(setting: Setting<T>, userId?: string): Promise<T> {
  return typeof setting === "function" ? (setting as (userId?: string) => Promise<T>)(userId) : setting;
}
