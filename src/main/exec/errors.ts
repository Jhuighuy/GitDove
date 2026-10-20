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
}> {}

/** A path is not inside a Git repository. */
export class NotARepositoryError extends Data.TaggedError("NotARepositoryError")<{
  readonly message: string;
  readonly path: string;
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

export class InvalidInputError extends Data.TaggedError("InvalidInputError")<{
  readonly message: string;
}> {}

export type AppError =
  | CommandError
  | SshError
  | NotARepositoryError
  | RepoNotOpenError
  | StaleGraphError
  | InvalidInputError;
