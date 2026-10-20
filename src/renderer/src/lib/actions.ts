import type { RepoId } from "@shared/domain";
import { toast } from "sonner";
import { ApiError } from "./api";
import { keys, queryClient } from "./queries";

interface RunOptions {
  /** Shows a progress toast while running (for slow, network-bound operations). */
  readonly progress?: string;
  readonly success?: string;
}

const inflight = new Set<string>();

/**
 * Runs a repository-mutating action, reporting failures as toasts and
 * refreshing the repository's data afterwards.
 */
export const runAction = async <A>(
  repo: RepoId,
  label: string,
  fn: () => Promise<A>,
  options: RunOptions = {},
): Promise<A | undefined> => {
  const key = `${repo}:${label}`;
  if (inflight.has(key)) return undefined;
  inflight.add(key);
  const id = options.progress ? toast.loading(options.progress) : undefined;
  try {
    const result = await fn();
    if (options.success) toast.success(options.success, { id });
    else if (id !== undefined) toast.dismiss(id);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const detail = e instanceof ApiError ? e.detail : undefined;
    toast.error(`${label} failed`, {
      id,
      description: detail && detail !== message ? `${message}\n\n${detail}` : message,
      duration: 10000,
    });
    return undefined;
  } finally {
    inflight.delete(key);
    // Watchers will pick up changes too, but refresh eagerly for snappiness.
    void queryClient.invalidateQueries({ queryKey: keys.info(repo) });
    void queryClient.invalidateQueries({ queryKey: keys.refs(repo) });
    void queryClient.invalidateQueries({ queryKey: keys.status(repo) });
  }
};
