import { mayRunGitlab } from "@shared/avatars";
import type { RepoId } from "@shared/domain";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo } from "react";
import { api } from "@/lib/api";
import { linkify, referenceRepo, type WebRepo } from "@/lib/links";
import { keys, useRefs } from "@/lib/queries";

/**
 * Where the repository's references point. A host whose name gives nothing away may be a
 * self-hosted GitLab (e.g. git.example.com); the main process asks it, once per session.
 */
const useReferenceRepo = (repo: RepoId): WebRepo | null => {
  const { data } = useRefs(repo);
  const web = useMemo(() => referenceRepo(data?.remotes ?? []), [data?.remotes]);
  const host = web?.forge === "other" && mayRunGitlab(web.host) ? web.host : null;
  const { data: gitlab } = useQuery({
    queryKey: keys.isGitlab(host ?? ""),
    queryFn: () => api("web.isGitlab", host!),
    enabled: host !== null,
    retry: false,
  });
  return useMemo(
    () => (web && host && gitlab ? { ...web, forge: "gitlab" } : web),
    [web, host, gitlab],
  );
};

/**
 * Text with clickable URLs and issue or pull request references. Links open in the browser
 * (the main process sends every new window there).
 */
export function LinkedText({ repo, text }: { repo: RepoId; text: string }) {
  const web = useReferenceRepo(repo);
  const segments = useMemo(() => linkify(text, web), [text, web]);
  // Segments are keyed by where they start in the text.
  return segments.map((s) =>
    s.href ? (
      <a
        key={s.start}
        href={s.href}
        target="_blank"
        rel="noreferrer"
        title={s.href}
        className="text-primary hover:underline"
      >
        {s.text}
      </a>
    ) : (
      <Fragment key={s.start}>{s.text}</Fragment>
    ),
  );
}
