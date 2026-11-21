import { type AppMenuItem, type AppMenuPage, type ViewMenuItem } from "@realentity/storm-shared";
import { useOutletContext } from "react-router-dom";
import { type Loaded } from "./use-load";

/** What the signed-in layout loads once for its pages: the installed Apps and the pipelines' pages. */
export interface LayoutContext {
  apps: Loaded<AppMenuItem[]>;
  views: Loaded<ViewMenuItem[]>;
  /** Proposals waiting for a decision, all of them. */
  pending: number;
}

export function useLayout(): LayoutContext {
  return useOutletContext<LayoutContext>();
}

/** Where one of an App's pages is. */
export function appPageUrl(appId: string, page: Pick<AppMenuPage, "kind" | "type">): string {
  return `/${page.kind === "report" ? "r" : "a"}/${appId}/${encodeURIComponent(page.type)}`;
}

/** Where an App opens: its first page; one without pages opens where it is managed. */
export function appUrl(app: Pick<AppMenuItem, "appId" | "pages">): string {
  return app.pages[0] ? appPageUrl(app.appId, app.pages[0]) : `/apps/${app.appId}`;
}
