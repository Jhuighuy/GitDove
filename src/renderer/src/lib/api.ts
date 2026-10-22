import type {
  ApiArgs,
  ApiMethod,
  ApiResult,
  CancellableMethod,
  EventName,
  Events,
  RpcError,
} from "@shared/ipc";
import { useEffect, useLayoutEffect, useRef } from "react";

/** Error thrown by {@link api} when the main process reports a failure. */
export class ApiError extends Error {
  readonly tag: string;
  readonly detail: string | undefined;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "ApiError";
    this.tag = error.tag;
    this.detail = error.detail;
  }
}

/** Calls a main-process API method. */
export const api = async <M extends ApiMethod>(
  method: M,
  ...args: ApiArgs<M>
): Promise<ApiResult<M>> => {
  const result = await window.gitdove.invoke(method, ...args);
  if (!result.ok) throw new ApiError(result.error);
  return result.value;
};

/**
 * Calls a read-only main-process method that `signal` cancels, e.g. a TanStack Query's signal
 * (aborted when no view waits for the query any more): the main process then stops its git
 * commands, and the call fails with the signal's reason. Writes are not cancellable.
 */
export const apiWithSignal = async <M extends CancellableMethod>(
  signal: AbortSignal | undefined,
  method: M,
  ...args: ApiArgs<M>
): Promise<ApiResult<M>> => {
  if (!signal) return api(method, ...args);
  signal.throwIfAborted();
  let cancel = () => {};
  const onAbort = () => cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await window.gitdove.invokeCancellable(method, args, (c) => {
      cancel = c;
    });
    if (result.ok) return result.value;
    // Interrupted by the cancel.
    signal.throwIfAborted();
    throw new ApiError(result.error);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** Subscribes to a main-process event for the lifetime of the component. */
export const useEvent = <E extends EventName>(event: E, listener: (payload: Events[E]) => void) => {
  const ref = useRef(listener);
  useLayoutEffect(() => {
    ref.current = listener;
  });
  useEffect(() => window.gitdove.on(event, (p) => ref.current(p)), [event]);
};

export const platform = window.gitdove.platform;
export const isMac = platform === "darwin";
export const modKey = isMac ? "⌘" : "Ctrl+";
