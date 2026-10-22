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
  // Asked at the remote's own scheme and port (e.g. http://git.lan:8080).
  const origin = web?.forge === "other" && mayRunGitlab(web.host) ? web.origin : null;
  const { data: gitlab } = useQuery({
    queryKey: keys.isGitlab(origin ?? ""),
    queryFn: () => api("web.isGitlab", origin!),
    enabled: origin !== null,
    retry: false,
  });
  return useMemo(
    () => (web && origin && gitlab ? { ...web, forge: "gitlab" } : web),
    [web, origin, gitlab],
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
