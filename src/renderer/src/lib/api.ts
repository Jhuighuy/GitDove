import type { ApiArgs, ApiMethod, ApiResult, EventName, Events, RpcError } from "@shared/ipc";
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
