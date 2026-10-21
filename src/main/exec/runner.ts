import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Effect } from "effect";
import { CommandError, SshError } from "./errors";
import { completion, type SpawnResult, type Stdin } from "./spawn";

/*
 * A persistent command runner: one long-lived POSIX `sh` on a remote host that
 * executes many commands over a single SSH session, so a command costs a fork
 * on the remote instead of an SSH session setup plus a login shell.
 *
 * Requests are single lines on the runner's stdin:
 *
 *   X <id> <limit> <command> [<stdin>]    run a command
 *   K <id>                                kill a running command
 *
 * `<command>` (a shell script) and `<stdin>` are `printf` format strings that
 * use only printable ASCII without spaces (everything else is an octal escape),
 * so `read` splits them reliably and `printf` restores the exact bytes. With a
 * `<limit>` > 0, stdout is cut after `<limit> + 1` bytes (so truncation is
 * detectable) and the command is killed by SIGPIPE.
 *
 * Commands run concurrently in the background with their output captured in
 * files of a private temporary directory. A single writer process serializes
 * the responses, so frames never interleave:
 *
 *   @GDR <id> <exit code> <stdout length> <stderr length>\n<stdout><stderr>
 *
 * The runner greets with `@GDR-HELLO 1\n` once it is ready.
 */
export const RUNNER_SCRIPT = `d=$(mktemp -d "\${TMPDIR:-/tmp}/gitdove.XXXXXX" 2>/dev/null) ||
  { d=\${TMPDIR:-/tmp}/gitdove.$$ && (umask 077 && mkdir "$d"); } || exit 1
trap 'cd / && rm -rf "$d"' EXIT
trap 'exit 1' HUP INT TERM
cd "$d" && mkfifo q || exit 1
hc=
head -c 1 </dev/null >/dev/null 2>&1 && hc=1
tree() {
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v r="$1" '{ k[NR] = $1; p[NR] = $2 }
    END { s = " " r " "; n = 1; while (n) { n = 0; for (i in k)
      if (index(s, " " p[i] " ") && !index(s, " " k[i] " ")) { s = s k[i] " "; n = 1 } }
      print s }'
}
# Whether a process listed in $1 ("pid command" lines) still runs. Zombies don't count, and a
# process id now running another command was reused. Without ps, kill -0 decides.
alive() {
  while read -r q c; do
    s=$(ps -o stat= -p "$q" 2>/dev/null) || { kill -0 "$q" 2>/dev/null && return 0; continue; }
    case $s in *Z*) continue ;; esac
    [ "$(ps -o comm= -p "$q" 2>/dev/null)" = "$c" ] && return 0
  done <"$1"
  return 1
}
job() {
  if [ "$2" -gt 0 ] && [ -n "$hc" ]; then
    { (. "./$1.c") <"$1.i" 2>"$1.e" 3>&- & echo $! >"$1.p"
      [ -f "$1.k" ] && kill $! 2>/dev/null; wait $!; echo $? >"$1.x"
    } | head -c "$(($2 + 1))" >"$1.o"
    read -r x <"$1.x"
  else
    (. "./$1.c") <"$1.i" >"$1.o" 2>"$1.e" 3>&- & echo $! >"$1.p"
    [ -f "$1.k" ] && kill $! 2>/dev/null; wait $!; x=$?
  fi
  # A killed command is reported once everything it started is gone too (see K).
  if [ -f "$1.t" ]; then while alive "$1.t"; do sleep 0.05 2>/dev/null || sleep 1; done; fi
  : >"$1.p"
  set -- "$1" "$x" $(wc -c "$1.o" "$1.e")
  printf '@GDR %s %s %s %s\\n' "$1" "$2" "$3" "$5" >"$1.h"
  echo "$1" >&3
}
while read -r id; do
  cat "$id.h" "$id.o" "$id.e"
  rm -f "$id.c" "$id.i" "$id.o" "$id.e" "$id.h" "$id.x" "$id.p" "$id.k" "$id.t"
done <q &
exec 3>q
printf '@GDR-HELLO 1\\n'
while read -r op id l c i; do
  case $op in
  X) printf "$c" >"$id.c"; printf "$i" >"$id.i"; job "$id" "$l" & ;;
  K) p=; read -r p 2>/dev/null <"$id.p"
     if [ -n "$p" ]; then
       # The command and everything it started (e.g. git merge behind git pull): SIGTERM,
       # then SIGKILL for what is left after 3 seconds.
       t=$(tree "$p"); [ -n "$t" ] || t=$p
       for q in $t; do echo "$q $(ps -o comm= -p "$q" 2>/dev/null)"; done >"$id.t"
       kill $t 2>/dev/null
       (sleep 3; alive "$id.t" && kill -9 $t 2>/dev/null) &
     else : >"$id.k"; fi ;;
  esac
done
exec 3>&-
for p in *.p; do read -r k 2>/dev/null <"$p" && kill "$k" 2>/dev/null; done
wait
`;

/** Largest stdin payload sent through the runner (encoding costs up to 4x). */
export const MAX_RUNNER_STDIN = 16 * 1024;

const MAX_STDERR = 64 * 1024;

const isPlain = (b: number) => b > 0x20 && b < 0x7f && b !== 0x25 && b !== 0x5c;

/**
 * Encodes bytes as a `printf` format string made of printable, space-free
 * ASCII. Escapes are always three octal digits, which every `printf` reads as
 * one escape (even when a digit follows).
 */
export const encodePrintf = (data: Stdin): string => {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let out = "";
  let plainFrom = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // A leading "-" would be taken as an option by some printf builtins.
    if (isPlain(b) && !(i === 0 && b === 0x2d)) continue;
    out += bytes.toString("latin1", plainFrom, i);
    out += b === 0x25 ? "%%" : b === 0x5c ? "\\\\" : `\\${b.toString(8).padStart(3, "0")}`;
    plainFrom = i + 1;
  }
  return out + bytes.toString("latin1", plainFrom);
};

/** Builds a request line that runs `command` (a shell script) on the runner. */
export const encodeRequest = (
  id: number,
  command: string,
  stdin: Stdin | undefined,
  limit: number,
): string => {
  const parts = ["X", String(id), String(limit), encodePrintf(command)];
  if (stdin !== undefined && stdin.length > 0) parts.push(encodePrintf(stdin));
  return parts.join(" ") + "\n";
};

export interface RunnerResponse {
  readonly id: number;
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type RunnerEvent =
  | { readonly kind: "hello" }
  | ({ readonly kind: "response" } & RunnerResponse);

const MAX_HEADER = 256;
const HEADER_RE = /^@GDR (\d+) (\d+) (\d+) (\d+)$/;

/** Incremental parser for the runner's output stream. */
export class ResponseParser {
  private header: Buffer[] = [];
  private headerLength = 0;
  private frame: { id: number; exitCode: number; stdoutLength: number; total: number } | null =
    null;
  private body: Buffer[] = [];
  private received = 0;
  private failed = false;

  constructor(
    private readonly onEvent: (event: RunnerEvent) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  push(chunk: Buffer): void {
    let off = 0;
    while (off < chunk.length && !this.failed) {
      if (this.frame === null) {
        const nl = chunk.indexOf(0x0a, off);
        const end = nl < 0 ? chunk.length : nl;
        this.header.push(chunk.subarray(off, end));
        this.headerLength += end - off;
        if (this.headerLength > MAX_HEADER) {
          this.fail("Runner protocol error: header too long");
          return;
        }
        if (nl < 0) return;
        off = nl + 1;
        const line = Buffer.concat(this.header).toString("latin1");
        this.header = [];
        this.headerLength = 0;
        this.startFrame(line);
      } else {
        const take = Math.min(this.frame.total - this.received, chunk.length - off);
        this.body.push(chunk.subarray(off, off + take));
        this.received += take;
        off += take;
        if (this.received === this.frame.total) this.endFrame();
      }
    }
  }

  private startFrame(line: string): void {
    if (line === "@GDR-HELLO 1") {
      this.onEvent({ kind: "hello" });
      return;
    }
    const m = HEADER_RE.exec(line);
    if (!m) {
      this.fail(`Runner protocol error: unexpected ${JSON.stringify(line.slice(0, 80))}`);
      return;
    }
    const stdoutLength = Number(m[3]);
    this.frame = {
      id: Number(m[1]),
      exitCode: Number(m[2]),
      stdoutLength,
      total: stdoutLength + Number(m[4]),
    };
    if (this.frame.total === 0) this.endFrame();
  }

  private endFrame(): void {
    const f = this.frame!;
    const body = Buffer.concat(this.body, f.total);
    this.frame = null;
    this.body = [];
    this.received = 0;
    this.onEvent({
      kind: "response",
      id: f.id,
      exitCode: f.exitCode,
      stdout: body.subarray(0, f.stdoutLength),
      stderr: body.subarray(f.stdoutLength),
    });
  }

  private fail(message: string): void {
    this.failed = true;
    this.onError(new Error(message));
  }
}

type Callback = (response: RunnerResponse | Error) => void;

/** Client side of a runner process (see `RUNNER_SCRIPT`). */
export class Runner {
  private nextId = 1;
  private readonly pending = new Map<number, Callback>();
  private error: Error | null = null;
  private stderr = "";
  private onHello: (() => void) | null;

  private constructor(
    private readonly child: ChildProcess,
    onHello: () => void,
  ) {
    this.onHello = onHello;
    const parser = new ResponseParser(
      (event) => {
        if (event.kind === "hello") {
          this.onHello?.();
          this.onHello = null;
          this.onFailure = null;
          return;
        }
        const cb = this.pending.get(event.id);
        this.pending.delete(event.id);
        cb?.(event);
      },
      (error) => this.fail(error),
    );
    child.stdout!.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 16384) this.stderr += chunk.toString("utf8");
    });
    child.stdin!.on("error", () => {
      // The exit handler reports the failure.
    });
    child.on("error", (e) => this.fail(e));
    child.on("close", (code, signal) =>
      this.fail(new Error(`Runner exited with ${signal ?? code}${this.stderrSuffix()}`)),
    );
  }

  /**
   * Starts a runner by spawning `file args`, which must run `RUNNER_SCRIPT` with
   * its stdin and stdout connected to ours. Interrupting kills the process.
   */
  static start(file: string, args: readonly string[]): Effect.Effect<Runner, Error> {
    return Effect.callback<Runner, Error>((resume) => {
      const child = nodeSpawn(file, args as string[], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
      const runner: Runner = new Runner(child, () => resume(Effect.succeed(runner)));
      runner.onFailure = (e) => resume(Effect.fail(e));
      return Effect.sync(() => runner.close());
    });
  }

  /** Called once when the runner dies before saying hello. */
  private onFailure: ((e: Error) => void) | null = null;

  get alive(): boolean {
    return this.error === null;
  }

  /** Runs `command`; `callback` receives the response or the runner's failure. */
  run(command: string, stdin: Stdin | undefined, limit: number, callback: Callback) {
    const id = this.nextId++;
    if (this.error) {
      callback(this.error);
      return id;
    }
    this.pending.set(id, callback);
    this.child.stdin!.write(encodeRequest(id, command, stdin, limit));
    return id;
  }

  /**
   * Kills a running command; its callback is not called anymore. `onSettled` runs once the
   * command has exited (the runner still reports killed commands) or the runner is gone.
   */
  cancel(id: number, onSettled?: () => void): void {
    if (!this.pending.has(id) || this.error) {
      onSettled?.();
      return;
    }
    this.pending.set(id, () => onSettled?.());
    this.child.stdin!.write(`K ${id}\n`);
  }

  /** Ends the runner; the remote side kills running commands and cleans up. */
  close(): void {
    this.fail(new Error("Runner closed"));
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    this.onFailure?.(error);
    this.onFailure = null;
    this.onHello = null;
    for (const cb of this.pending.values()) cb(error);
    this.pending.clear();
    this.child.stdin!.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // Give the remote side a moment to clean up after EOF.
      setTimeout(() => this.child.kill(), 2000).unref();
    }
  }

  private stderrSuffix(): string {
    const last = this.stderr.trim().split("\n").at(-1);
    return last ? `: ${last}` : "";
  }
}

/**
 * Runs a command on a runner as an Effect, with the same semantics as `spawn`
 * (`okCodes`, `maxBytes`, interruption kills the command). A runner failure is
 * reported as an `SshError`.
 */
export const runOnRunner = (
  runner: Runner,
  host: string,
  command: string,
  options: {
    readonly stdin?: Stdin;
    readonly okCodes?: readonly number[];
    readonly maxBytes?: number;
    readonly display: string;
  },
): Effect.Effect<SpawnResult, CommandError | SshError> =>
  Effect.callback<SpawnResult, CommandError | SshError>((resume) => {
    const limit = options.maxBytes ?? 0;
    let sent = false;
    const id = runner.run(command, options.stdin, limit, (r) => {
      if (r instanceof Error) {
        // A runner that was already dead never received the command.
        resume(
          Effect.fail(new SshError({ message: r.message, host, stderr: "", mayHaveRun: sent })),
        );
        return;
      }
      const truncated = limit > 0 && r.stdout.length > limit;
      resume(
        completion(
          {
            stdout: truncated ? r.stdout.subarray(0, limit) : r.stdout,
            stderr: r.stderr.subarray(0, MAX_STDERR).toString("utf8"),
            code: r.exitCode,
            truncated,
          },
          options.okCodes ?? [0],
          options.display,
        ),
      );
    });
    // `run` reports a dead runner synchronously; otherwise the request is on its way.
    sent = true;
    // Interrupting waits until the killed command, and everything it started, is gone on the
    // host: the runner reports it then (SIGKILL follows SIGTERM), or the runner itself fails.
    return Effect.callback<void>((settled) => runner.cancel(id, () => settled(Effect.void)));
  });
