import type { RepoId } from "@shared/domain";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** A commit message being written in a repository. */
export interface Draft {
  readonly summary: string;
  readonly description: string;
  readonly amend: boolean;
  /**
   * The previous commit's message as prefilled for amending (`summary\n\ndescription`), while
   * the text is still that: unchecking "Amend" then clears it again.
   */
  readonly prefill: string | null;
}

export const EMPTY_DRAFT: Draft = { summary: "", description: "", amend: false, prefill: null };

/** The message a draft commits. */
export const draftMessage = (d: Pick<Draft, "summary" | "description">) =>
  d.description.trim() ? `${d.summary.trim()}\n\n${d.description.trim()}` : d.summary.trim();

const isEmpty = (d: Draft) => !d.summary && !d.description && !d.amend;

/** Whether a draft's text is still the previous commit's message, as prefilled for amending. */
const isPrefilled = (d: Draft) => d.prefill !== null && draftMessage(d) === d.prefill;

interface DraftsState {
  readonly drafts: Readonly<Record<RepoId, Draft>>;
  set(repo: RepoId, d: Partial<Draft>): void;
  /**
   * Turns amending off. The previous commit's message, if still unchanged, goes too: it is not
   * meant for a new commit.
   */
  stopAmending(repo: RepoId): void;
  clear(repo: RepoId): void;
}

/**
 * Commit messages per repository. Messages survive reloads and restarts. Amending does not (it
 * is a decision about the next commit, and the previous commit may have changed meanwhile), and
 * neither does the previous commit's message prefilled for it.
 */
export const useDrafts = create<DraftsState>()(
  persist(
    (set, get) => ({
      drafts: {},
      set: (repo, d) =>
        set((s) => {
          const next = { ...(s.drafts[repo] ?? EMPTY_DRAFT), ...d };
          const { [repo]: _, ...rest } = s.drafts;
          return { drafts: isEmpty(next) ? rest : { ...rest, [repo]: next } };
        }),
      stopAmending: (repo) => {
        const d = get().drafts[repo];
        if (!d || (!d.amend && d.prefill === null)) return;
        get().set(repo, {
          amend: false,
          prefill: null,
          ...(isPrefilled(d) ? { summary: "", description: "" } : {}),
        });
      },
      clear: (repo) =>
        set((s) => {
          const { [repo]: _, ...rest } = s.drafts;
          return { drafts: rest };
        }),
    }),
    {
      name: "gitdove.drafts",
      version: 1,
      // Typing must not fail because storage does (full, or unavailable): drafts then stay in memory.
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch {}
        },
        removeItem: (key) => {
          try {
            localStorage.removeItem(key);
          } catch {}
        },
      })),
      partialize: (s) => ({
        drafts: Object.fromEntries(
          Object.entries(s.drafts)
            .filter(([, d]) => (d.summary || d.description) && !isPrefilled(d))
            .map(([repo, d]) => [repo, { summary: d.summary, description: d.description }]),
        ),
      }),
      merge: (persisted, current) => {
        const saved = (persisted as { drafts?: Record<string, Partial<Draft>> } | undefined)
          ?.drafts;
        const drafts: Record<RepoId, Draft> = {};
        for (const [repo, d] of Object.entries(saved ?? {})) {
          if (typeof d?.summary !== "string" || typeof d.description !== "string") continue;
          drafts[repo] = { ...EMPTY_DRAFT, summary: d.summary, description: d.description };
        }
        return { ...current, drafts };
      },
    },
  ),
);

export const useDraft = (repo: RepoId): Draft => useDrafts((s) => s.drafts[repo] ?? EMPTY_DRAFT);
