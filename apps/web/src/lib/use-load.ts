import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveEvents, type LiveSignal } from "./events";

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Fetches again; the current data stays on screen meanwhile. */
  reload: () => void;
}

/** Bursts of events (a forEach step over many items) cause one refetch. */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * Loads data and reloads it when `deps` change, and when a live event matches `refreshOn` (a resync always does).
 * Only the latest request's answer is kept.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[], refreshOn?: (signal: LiveSignal) => boolean): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(() => {
    const mine = ++sequence.current;
    setLoading(true);
    loader.current().then(
      (value) => {
        if (mine !== sequence.current) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (reason: unknown) => {
        if (mine !== sequence.current) return;
        setError(reason);
        setLoading(false);
      },
    );
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` are the caller's
  useEffect(reload, deps);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useLiveEvents((signal) => {
    if (!refreshOn || (signal.type !== "resync" && !refreshOn(signal))) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, REFRESH_DEBOUNCE_MS);
  });

  return { data, error, loading, reload };
}

/**
 * Runs an action with a busy flag; returns its result, or undefined when it threw. The error is kept in `error`
 * (for an alert on the page) and passed to `onError` (for a toast).
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = useCallback(async <R>(action: () => Promise<R>, onError?: (error: unknown) => void): Promise<R | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await action();
    } catch (reason) {
      setError(reason);
      onError?.(reason);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(undefined) };
}
