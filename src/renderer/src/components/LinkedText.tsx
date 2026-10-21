import type { RepoId } from "@shared/domain";
import { Fragment, useMemo } from "react";
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
  // Segments are keyed by where they start in the text.
  let offset = 0;
  return segments.map((s) => {
    const key = offset;
    offset += s.text.length;
    return s.href ? (
      <a
        key={key}
        href={s.href}
        target="_blank"
        rel="noreferrer"
        title={s.href}
        className="text-primary hover:underline"
      >
        {s.text}
      </a>
    ) : (
      <Fragment key={key}>{s.text}</Fragment>
    );
  });
}
