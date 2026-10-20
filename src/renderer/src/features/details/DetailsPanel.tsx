import type { RepoId } from "@shared/domain";
import { useRepoUi } from "@/stores/repo-ui";
import { CommitPanel } from "./CommitPanel";
import { WipPanel } from "./WipPanel";

export function DetailsPanel({ repo }: { repo: RepoId }) {
  const { selection } = useRepoUi(repo);
  if (selection?.kind === "commit") return <CommitPanel repo={repo} hash={selection.hash} />;
  return <WipPanel repo={repo} />;
}
