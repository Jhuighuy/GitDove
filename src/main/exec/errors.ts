import { Data } from "effect";

/** A process could not be started or exited with an unexpected status. */
export class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;
}> {}

/** The SSH connection to a host could not be established or was lost. */
export class SshError extends Data.TaggedError("SshError")<{
  readonly message: string;
  readonly host: string;
  readonly stderr: string;
  /** The command may have started on the host, so running it again could repeat its effects. */
  readonly mayHaveRun: boolean;
}> {}

/** A path is not inside a Git repository (or Git refuses to open it). */
export class NotARepositoryError extends Data.TaggedError("NotARepositoryError")<{
  readonly message: string;
  readonly path: string;
  /** What Git said, sent to the renderer as the error's detail. */
  readonly stderr: string;
}> {}

/** A repository was referenced that has not been opened. */
export class RepoNotOpenError extends Data.TaggedError("RepoNotOpenError")<{
  readonly message: string;
  readonly repo: string;
}> {}

/** The graph version requested by the renderer is outdated. */
export class StaleGraphError extends Data.TaggedError("StaleGraphError")<{
  readonly message: string;
}> {}

/** A worktree can only be removed by force: it is locked or has changes that would be lost. */
export class WorktreeNeedsForceError extends Data.TaggedError("WorktreeNeedsForceError")<{
  readonly message: string;
  readonly stderr: string;
}> {}

export class InvalidInputError extends Data.TaggedError("InvalidInputError")<{
  readonly message: string;
}> {}

/** The user cancelled a running operation. */
export class CancelledError extends Data.TaggedError("CancelledError")<{
  readonly message: string;
}> {}

export type AppError =
  | CancelledError
  | CommandError
  | SshError
  | NotARepositoryError
  | RepoNotOpenError
  | StaleGraphError
  | InvalidInputError
  | WorktreeNeedsForceError;
