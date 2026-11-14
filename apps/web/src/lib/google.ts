import { api } from "./endpoints";

/**
 * Off to Google's consent screen (M14-T1); back to `returnTo` (this page by default) with ?google=… With `account`,
 * signing in as that one (reconnecting it); without, choosing which (M50-T8).
 */
export async function connectGoogle(returnTo = window.location.pathname, account?: string): Promise<void> {
  const { url } = await api.google.connect(returnTo, account);
  window.location.assign(url);
}
