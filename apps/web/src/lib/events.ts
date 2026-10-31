import { EVENTS_PATH, type AppEvent } from "@ai-me/shared";
import { useEffect, useRef, useSyncExternalStore } from "react";

/** "resync": the socket (re)connected, so events may have been missed; refetch everything shown. */
export type LiveSignal = AppEvent | { type: "resync" };
type Handler = (signal: LiveSignal) => void;
export type ConnectionState = "connecting" | "live" | "offline";

const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * One WebSocket to /api/events while signed in. Events are refresh hints (ids and statuses); pages refetch what they
 * show. Reconnects with backoff; a 4401 close (session ended) stops until the next sign-in.
 */
class EventStream {
  private socket: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private stateListeners = new Set<() => void>();
  private state: ConnectionState = "offline";
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;

  start(): void {
    this.wanted = true;
    if (!this.socket) this.connect();
  }

  stop(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setState("offline");
  }

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  readonly subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  readonly getState = (): ConnectionState => this.state;

  private connect(): void {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}${EVENTS_PATH}`);
    this.socket = socket;
    this.setState("connecting");
    socket.onopen = () => {
      this.attempt = 0;
      this.setState("live");
      this.emit({ type: "resync" });
    };
    socket.onmessage = (message: MessageEvent<string>) => {
      try {
        this.emit(JSON.parse(message.data) as AppEvent);
      } catch {
        // Not an event; ignore.
      }
    };
    socket.onclose = (close) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setState("offline");
      if (!this.wanted || close.code === 4401) return;
      const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
      this.retry = setTimeout(() => {
        this.retry = null;
        if (this.wanted) this.connect();
      }, delay);
    };
  }

  private emit(signal: LiveSignal): void {
    for (const handler of this.handlers) handler(signal);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener();
  }
}

export const events = new EventStream();

/** Calls `handler` for every live event (and on resync). The latest handler is used without resubscribing. */
export function useLiveEvents(handler: Handler): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => events.subscribe((signal) => latest.current(signal)), []);
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(events.subscribeState, events.getState);
}
