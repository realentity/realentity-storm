import { api } from "./endpoints";

/** Off to Google's consent screen (M14-T1); back to `returnTo` (this page by default) with ?google=… */
export async function connectGoogle(returnTo = window.location.pathname): Promise<void> {
  const { url } = await api.google.connect(returnTo);
  window.location.assign(url);
}
