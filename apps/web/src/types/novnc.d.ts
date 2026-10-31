/** The part of noVNC's RFB client the live view uses (@novnc/novnc ships no types). */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string }; shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    /** Puts text on the remote clipboard; Ctrl+V in the remote page pastes it. */
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(): void;
  }
}
