/**
 * History editing: interactive rebases from a plan, rewording without touching the working tree,
 * and picking commits onto branches that are not checked out. Everything here runs as POSIX
 * `sh` scripts, so that it works the same on SSH hosts and takes one round trip.
 */
import type { OperationInfo, RebaseStep, RepoState } from "@shared/domain";
import { shellQuote } from "../exec/shell";

/** A full commit hash (SHA-1 or SHA-256). */
export const isFullHash = (s: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);

/**
 * A commit message as git stores it: no trailing whitespace on lines, no blank lines at either
 * end, and exactly one newline at the end. Lines starting with "#" are kept.
 */
export const normalizeMessage = (message: string): string =>
  `${message
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd()}\n`;

/**
 * A shell word that prints `message` with `printf '%b'`, on a single line (rebase todo lines
 * cannot span lines): backslashes are doubled and newlines become `\n`.
 */
const printfWord = (message: string) =>
  shellQuote(message.replaceAll("\\", "\\\\").replaceAll("\n", "\\n"));

/** Sets the message of the commit just made, from a rebase `exec` step. */
const amendMessage = (message: string) =>
  `exec printf '%b' ${printfWord(normalizeMessage(message))} | ` +
  "git commit --amend --no-verify --allow-empty --cleanup=whitespace -F -";

/**
 * The todo list of an interactive rebase that carries out `steps` (oldest first). Commits folded
 * into another follow it with `fixup`; a new message is set with an `exec` step once the commit
 * and what is folded into it are in place. An `edit` step stops there: with the commit itself
 * when nothing else applies to it (so that git amends it with what the user stages), otherwise
 * with a `break` after the rest.
 *
 * Throws when the steps do not make sense, e.g. a fixup with nothing before it.
 */
export const rebaseTodo = (steps: readonly RebaseStep[]): string => {
  interface Group {
    readonly head: RebaseStep;
    readonly folded: RebaseStep[];
    message: string | undefined;
  }
  const groups: Group[] = [];
  const dropped: string[] = [];
  for (const step of steps) {
    if (step.action === "drop") {
      dropped.push(step.hash);
      continue;
    }
    if (step.action === "fixup") {
      const group = groups.at(-1);
      if (!group) throw new Error("The oldest commit cannot be folded into the one before it");
      group.folded.push(step);
      if (step.message !== undefined) group.message = step.message;
      continue;
    }
    groups.push({ head: step, folded: [], message: step.message });
  }
  if (groups.length === 0 && dropped.length === 0) throw new Error("Nothing to rebase");

  const lines: string[] = [];
  for (const { head, folded, message } of groups) {
    if (message !== undefined && !message.trim())
      throw new Error("Commit messages cannot be empty");
    const simpleEdit = head.action === "edit" && folded.length === 0 && message === undefined;
    lines.push(`${simpleEdit ? "edit" : "pick"} ${head.hash}`);
    for (const f of folded) lines.push(`fixup ${f.hash}`);
    if (message !== undefined) lines.push(amendMessage(message));
    if (head.action === "edit" && !simpleEdit) lines.push("break");
  }
  for (const hash of dropped) lines.push(`drop ${hash}`);
  return `${lines.join("\n")}\n`;
};

/**
 * Runs an interactive rebase with the todo list read from stdin: git's sequence editor copies it
 * over the one git wrote. Uncommitted changes are stashed and restored around the rebase. Commits
 * that end up empty are dropped, as rebases do by default.
 * Arguments: the git directory, and the base commit (`--root` to rewrite from the first commit).
 */
export const REWRITE_SCRIPT = String.raw`
todo="$1/gitdove-rebase-todo"
cat > "$todo" || exit
GITDOVE_TODO=$todo GIT_SEQUENCE_EDITOR='cp "$GITDOVE_TODO"' git rebase -i --autostash --empty=drop "$2"
status=$?
rm -f "$todo"
exit $status
`;

/**
 * Rewrites a commit with the message read from stdin, and every commit from it to HEAD on top
 * of it, by editing the commit objects: trees, authors and the other messages stay as they are,
 * and the working tree and the index are not touched. Signatures are dropped, as the commits
 * change. HEAD (and with it the checked out branch) moves only if it did not move meanwhile.
 * Arguments: the commit, a scratch file for the message, and the reflog message.
 */
export const REWORD_SCRIPT = String.raw`
set -e
target=$1
MSGF=$2
cat > "$MSGF"
head=$(git rev-parse --verify HEAD)
if ! git merge-base --is-ancestor "$target" "$head"; then
  rm -f "$MSGF"
  echo "The commit is not on the current branch" >&2
  exit 3
fi
IDENT=$(git var GIT_COMMITTER_IDENT)
export IDENT MSGF
commits=$(git rev-list --parents -n 1 "$target"; git rev-list --reverse --topo-order --parents --ancestry-path "$target..$head")
while read -r c ps; do
  PARENTS=
  for p in $ps; do
    eval "q=\${m_$p:-$p}"
    PARENTS="$PARENTS $q"
  done
  if [ "$c" = "$target" ]; then REPLACE=1; else REPLACE=; fi
  export PARENTS REPLACE
  n=$(git cat-file commit "$c" | LC_ALL=C awk '
    BEGIN { header = 1; np = split(ENVIRON["PARENTS"], ps, " ") }
    header && /^$/ {
      header = 0
      print
      if (ENVIRON["REPLACE"] != "") {
        while ((getline line < ENVIRON["MSGF"]) > 0) print line
        exit
      }
      next
    }
    header && skip && /^ / { next }
    header { skip = 0 }
    header && /^tree / { print; for (i = 1; i <= np; i++) print "parent " ps[i]; next }
    header && /^parent / { next }
    header && /^committer / { print "committer " ENVIRON["IDENT"]; next }
    header && /^gpgsig/ { skip = 1; next }
    { print }
  ' | git hash-object -t commit -w --stdin)
  eval "m_$c=$n"
done <<EOF
$commits
EOF
rm -f "$MSGF"
eval "new=\$m_$head"
git update-ref -m "$3" HEAD "$new" "$head"
`;

/** Exit status of {@link PICK_INTO_SCRIPT} when a commit conflicts; it prints the commit. */
export const PICK_CONFLICT = 4;

/**
 * Picks commits onto a branch that is not checked out, without a working tree: each one is
 * merged with `git merge-tree` (Git 2.40 or newer) and committed with its author and message.
 * Commits whose changes are already there are skipped. The branch moves only when every commit
 * applied cleanly. Arguments: the branch's full ref, "1" to record where commits came from
 * ("" not to), the reflog message, then the commits in order.
 */
export const PICK_INTO_SCRIPT = String.raw`
set -e
ref=$1
x=$2
log=$3
shift 3
start=$(git rev-parse --verify "$ref^{commit}")
tip=$start
for c in "$@"; do
  set -- $(git rev-list --parents -n 1 "$c")
  if [ $# -ne 2 ]; then
    echo "Merge commits and root commits can only be picked onto the checked out branch" >&2
    exit 3
  fi
  status=0
  tree=$(git merge-tree --write-tree --merge-base="$2" "$tip" "$c") || status=$?
  if [ $status -eq 1 ]; then echo "$c" >&2; exit ${PICK_CONFLICT}; fi
  if [ $status -ne 0 ]; then exit $status; fi
  if [ "$tree" = "$(git rev-parse "$tip^{tree}")" ]; then continue; fi
  info=$(git show -s --format='%an%n%ae%n%ad' --date=raw "$c")
  msg=$(git show -s --format=%B "$c")
  if [ "$x" = 1 ]; then msg=$(printf '%s\n\n(cherry picked from commit %s)' "$msg" "$c"); fi
  tip=$(printf '%s\n' "$msg" | GIT_AUTHOR_NAME=$(printf '%s\n' "$info" | sed -n 1p) \
    GIT_AUTHOR_EMAIL=$(printf '%s\n' "$info" | sed -n 2p) \
    GIT_AUTHOR_DATE=$(printf '%s\n' "$info" | sed -n 3p) \
    git commit-tree "$tree" -p "$tip" -F -)
done
if [ "$tip" != "$start" ]; then git update-ref -m "$log" "$ref" "$tip" "$start"; fi
`;

// ---------------------------------------------------------------------------
// Operation in progress
// ---------------------------------------------------------------------------

/**
 * Prints the state of the operation in progress and where it stands, NUL-separated, see
 * `parseOperation`. Expects `$gd` to be the git directory; sets `$state`.
 */
export const OPERATION_SCRIPT = String.raw`
state=clean; head_name=; onto=; commit=; subject=; step=; total=; remaining=0; editing=
if [ -d "$gd/rebase-merge" ]; then
  state=rebasing; r="$gd/rebase-merge"
  head_name=$(cat "$r/head-name" 2>/dev/null); onto=$(cat "$r/onto" 2>/dev/null)
  step=$(cat "$r/msgnum" 2>/dev/null); total=$(cat "$r/end" 2>/dev/null)
  commit=$(cat "$r/stopped-sha" 2>/dev/null)
  [ -f "$r/amend" ] && editing=1
elif [ -d "$gd/rebase-apply" ]; then
  r="$gd/rebase-apply"
  if [ -f "$r/applying" ]; then state=applying; else state=rebasing; fi
  head_name=$(cat "$r/head-name" 2>/dev/null); onto=$(cat "$r/onto" 2>/dev/null)
  step=$(cat "$r/next" 2>/dev/null); total=$(cat "$r/last" 2>/dev/null)
  commit=$(cat "$r/original-commit" 2>/dev/null)
  subject=$(sed -n 1p "$r/final-commit" 2>/dev/null)
elif [ -f "$gd/MERGE_HEAD" ]; then
  state=merging; commit=$(sed -n 1p "$gd/MERGE_HEAD")
elif [ -f "$gd/CHERRY_PICK_HEAD" ]; then
  state=cherry-picking; commit=$(cat "$gd/CHERRY_PICK_HEAD")
elif [ -f "$gd/REVERT_HEAD" ]; then
  state=reverting; commit=$(cat "$gd/REVERT_HEAD")
elif [ -f "$gd/sequencer/todo" ]; then
  case $(sed -n 1p "$gd/sequencer/todo") in revert*) state=reverting ;; *) state=cherry-picking ;; esac
elif [ -f "$gd/BISECT_LOG" ]; then
  state=bisecting
fi
if [ -f "$gd/sequencer/todo" ] && [ -z "$step" ]; then
  remaining=$(grep -c . "$gd/sequencer/todo" 2>/dev/null) || remaining=0
  [ -n "$commit" ] && [ "$remaining" -gt 0 ] && remaining=$((remaining - 1))
fi
if [ -n "$commit" ] && [ -z "$subject" ]; then subject=$(git log -1 --format=%s "$commit" -- 2>/dev/null); fi
`;

/** The fields {@link OPERATION_SCRIPT} prints, in order. */
export const OPERATION_FIELDS =
  '"$state" "$head_name" "$onto" "$commit" "$subject" "$step" "$total" "$remaining" "$editing"';

const count = (s: string | undefined) => {
  const n = Number.parseInt(s ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const parseOperation = (
  fields: readonly string[],
): { state: RepoState; operation: OperationInfo | null } => {
  const [state = "clean", headName, onto, commit, subject, step, total, remaining, editing] =
    fields;
  if (state === "clean" || state === "bisecting") {
    return { state: state as RepoState, operation: null };
  }
  const s = count(step);
  const t = count(total);
  return {
    state: state as RepoState,
    operation: {
      branch: headName?.startsWith("refs/heads/") ? headName.slice("refs/heads/".length) : null,
      onto: onto || null,
      commit: commit || null,
      subject: subject || null,
      step: s,
      total: t,
      remaining: s !== null && t !== null ? Math.max(0, t - s) : (count(remaining) ?? 0),
      editing: editing === "1",
    },
  };
};
