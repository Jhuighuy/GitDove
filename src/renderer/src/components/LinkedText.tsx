import type { RepoId } from "@shared/domain";
import { useMemo } from "react";
import { linkify, referenceRepo } from "@/lib/links";
import { useRefs } from "@/lib/queries";

/**
 * Text with clickable URLs and issue or pull request references. Links open in the browser
 * (the main process sends every new window there).
 */
export function LinkedText({ repo, text }: { repo: RepoId; text: string }) {
  const { data } = useRefs(repo);
  const remotes = data?.remotes;
  const segments = useMemo(() => linkify(text, referenceRepo(remotes ?? [])), [text, remotes]);
  return segments.map((s, i) =>
    s.href ? (
      <a
        key={i}
        href={s.href}
        target="_blank"
        rel="noreferrer"
        title={s.href}
        className="text-primary hover:underline"
      >
        {s.text}
      </a>
    ) : (
      s.text
    ),
  );
}
