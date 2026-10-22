import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Effect } from "effect";
import { environmentReady } from "./environment";
import { CommandError, SshError } from "./errors";
import { completion, MAX_STDERR, type SpawnResult, type Stdin } from "./spawn";

/*
 * A persistent command runner: one long-lived POSIX `sh` on a remote host that
 * executes many commands over a single SSH session, so a command costs a fork
 * on the remote instead of an SSH session setup plus a login shell.
 *
 * Requests are lines on the runner's stdin:
 *
 *   D <id> <length>\n<bytes>                       append to command <id>'s stdin
 *   X <id> <limit> <stream> <length> <command> [<stdin>]
 *                                                  run a command
 *   K <id>                                         kill a running command
 *
 * `<command>` (a shell script) and an inline `<stdin>` are `printf` format strings that use
 * only printable ASCII without spaces (everything else is an octal escape), so `read` splits
 * them reliably and `printf` restores the exact bytes. Larger stdin comes before the command
 * in `D` requests, raw; `<length>` is its total size then (else `-`). With a `<limit>` > 0,
 * stdout is cut after `<limit> + 1` bytes (so truncation is detectable) and the command is
 * killed by SIGPIPE. With `<stream>` = 1, stdout is sent while the command runs.
 *
 * Commands run concurrently in the background with their output captured in files of a
 * private temporary directory. A single writer process sends the responses as frames of
 * at most 512 KiB, taking turns between commands, so a large response does not hold up
 * the others:
 *
 *   @GDR <id> O <length>\n<stdout bytes>           output (any number of these)
 *   @GDR <id> X <exit code> <length>\n<stderr>      the command is done
 *   @GDR <id> F <input|output>                     the runner lost the command's data
 *
 * A frame has exactly the length its header states (`dd conv=sync` pads short reads), so
 * whatever else writes to a command's output files (say, something it left running in the
 * background), the stream stays in sync. Output after the command exited is not sent; if the
 * files shrank meanwhile, the command fails with `F output`.
 *
 * The runner greets with `@GDR-HELLO 2\n` once it is ready; anything before that (e.g. a
 * chatty `.bashrc`) is ignored. The greeting starts a line of its own, also after output
 * without a final newline (e.g. a `.bashrc` that sets the terminal title).
 */
export const RUNNER_SCRIPT = `d=$(mktemp -d "\${TMPDIR:-/tmp}/gitdove.XXXXXX" 2>/dev/null) ||
  { d=\${TMPDIR:-/tmp}/gitdove.$$ && (umask 077 && mkdir "$d"); } || exit 1
trap 'cd / && rm -rf "$d"' EXIT
trap 'exit 1' HUP INT TERM
cd "$d" && mkfifo q || exit 1
# Files of command <id>: .c script, .i stdin, .o/.e stdout/stderr, .x exit code, .p process
# id, .k kill requested, .t processes being killed, .z stdin incomplete, .r output requested
# (streaming), .b dd's report on the frame being sent.
hc=
head -c 1 </dev/null >/dev/null 2>&1 && hc=1
tree() {
  ps -A -o pid= -o ppid= 2>/dev/null | awk -v r="$1" '{ k[NR] = $1; p[NR] = $2 }
    END { s = " " r " "; n = 1; while (n) { n = 0; for (i in k)
      if (index(s, " " p[i] " ") && !index(s, " " k[i] " ")) { s = s k[i] " "; n = 1 } }
      print s }'
}
# Prints the processes listed in $1 ("pid command" lines) that still run. Zombies don't
# count, and a process id now running another command was reused. Without ps, kill -0 decides.
survivors() {
  while read -r p c; do
    s=$(ps -o stat= -p "$p" 2>/dev/null) || { kill -0 "$p" 2>/dev/null && echo "$p"; continue; }
    case $s in *Z*) continue ;; esac
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" = "$c" ] && echo "$p"
  done 2>/dev/null <"$1"
}
# Asks the writer to send what command $1 has written so far, while it runs.
pump() {
  while :; do
    sleep 0.05 2>/dev/null || sleep 1
    [ -f "$1.r" ] || { : >"$1.r" && echo "$1" >&3; }
  done
}
# Runs command $1 (stdout limit $2, streamed if $3 = 1) and queues "<id> <exit> <stdout size>
# <stderr size> <streamed>" for the writer, or "<id> F input" if its stdin is incomplete.
job() {
  if [ -f "$1.z" ]; then echo "$1 F input" >&3; return; fi
  u=
  if [ "$3" = 1 ]; then pump "$1" & u=$!; fi
  if [ "$2" -gt 0 ] && [ -n "$hc" ]; then
    { (. "./$1.c") <"$1.i" 2>>"$1.e" 3>&- & echo $! >"$1.p"
      [ -f "$1.k" ] && kill $! 2>/dev/null; wait $!; echo $? >"$1.x"
    } | head -c "$(($2 + 1))" >>"$1.o"
    x=; read -r x 2>/dev/null <"$1.x"
  else
    (. "./$1.c") <"$1.i" >>"$1.o" 2>>"$1.e" 3>&- & echo $! >"$1.p"
    [ -f "$1.k" ] && kill $! 2>/dev/null; wait $!; x=$?
  fi
  [ -n "$u" ] && kill "$u" 2>/dev/null
  # A killed command is reported once everything it started is gone too (see K), without a
  # deadline: the write lock around it must stay held until that is confirmed.
  if [ -f "$1.t" ]; then
    while [ -n "$(survivors "$1.t")" ]; do sleep 0.05 2>/dev/null || sleep 1; done
  fi
  : >"$1.p"
  set -- "$1" "$3" $(wc -c "$1.o" "$1.e" 2>/dev/null)
  if [ $# = 8 ]; then o=$3 e=$5; else
    o=$(wc -c 2>/dev/null <"$1.o") || o=0
    e=$(wc -c 2>/dev/null <"$1.e") || e=0
  fi
  e=$((e))
  [ "$e" -gt 65536 ] && e=65536
  echo "$1 \${x:-255} $((o)) $e $2" >&3
}
# Writes bytes [$2, $2 + $3) of file $1: exactly $3 bytes, so the frame they are in stays
# intact whatever else writes to the file. Fails if they are not all there anymore (the file
# shrank); zeros stand in for them then. dd reads (once) and pads a short read with zeros;
# its report tells how it went. A dd that does not report has its copy measured instead.
ds=
case $(dd bs=1 count=1 </dev/zero 2>&1 >/dev/null) in 1+0*) ds=1 ;; esac
body() {
  : >"$id.b"
  if [ -z "$ds" ]; then
    { [ "$2" -gt 0 ] && dd bs=1 skip="$2" count=0; dd bs="$3" count=1; } 2>/dev/null <"$1" >"$id.b"
    r=$(wc -c 2>/dev/null <"$id.b") || r=0
    cat "$id.b"
    [ "$((r))" = "$3" ] && return 0
    dd bs=$(($3 - r)) count=1 </dev/zero 2>/dev/null
    return 1
  fi
  if [ $(($2 % $3)) = 0 ]; then
    dd bs="$3" skip=$(($2 / $3)) count=1 conv=sync 2>"$id.b" <"$1"
  else
    { dd bs=1 skip="$2" count=0 2>/dev/null; dd bs="$3" count=1 conv=sync 2>"$id.b"; } <"$1"
  fi
  r=; read -r r 2>/dev/null <"$id.b"
  case $r in
  1+0*) return 0 ;;
  0+1*) ;;
  *) dd bs="$3" count=1 </dev/zero 2>/dev/null ;;
  esac
  return 1
}
# Sends frames for tokens "<id>" (streaming) and "<id> <exit> ..." (done, see job): at most
# one output frame per token, which is queued again while there is more to send.
writer() {
  exec 4>q
  while read -r id x o e g; do
    [ "$id" = . ] && break
    [ -f "$id.c" ] || continue
    if [ "$x" = F ]; then printf '@GDR %s F %s\\n' "$id" "$o"; rm -f "$id".?; continue; fi
    eval "s=\\\${s$id:-0} f=\\\${f$id-}"
    if [ -z "$x" ]; then o=$(wc -c 2>/dev/null <"$id.o") || o=0; o=$((o)); fi
    if [ -z "$f" ] && [ "$o" -gt "$s" ]; then
      n=$((o - s))
      [ "$n" -gt 524288 ] && n=524288
      printf '@GDR %s O %s\\n' "$id" "$n"
      body "$id.o" "$s" "$n" || { f=1; eval "f$id=1"; }
      s=$((s + n))
      eval "s$id=$s"
    fi
    if [ -z "$x" ]; then
      if [ -z "$f" ] && [ "$o" -gt "$s" ]; then echo "$id" >&4; else rm -f "$id.r"; fi
      continue
    fi
    if [ -z "$f" ] && [ "$o" -gt "$s" ]; then echo "$id $x $o $e $g" >&4; continue; fi
    if [ -n "$f" ]; then
      printf '@GDR %s F output\\n' "$id"
    else
      printf '@GDR %s X %s %s\\n' "$id" "$x" "$e"
      [ "$e" -gt 0 ] && body "$id.e" 0 "$e"
    fi
    # Without streaming, no other token for it can follow: no need to wait for this.
    if [ "$g" = 1 ]; then rm -f "$id".?; else rm -f "$id".? & fi
    unset "s$id" "f$id"
  done
}
# Appends $2 bytes of our stdin to command $1's stdin, never taking bytes of the next request:
# dd reads once (with fullblock, until it has them all) and reads no more than it needs.
fb=
dd bs=1 count=0 iflag=fullblock </dev/null >/dev/null 2>&1 && fb=1
recv() {
  n=$2
  if [ -n "$fb" ]; then
    dd bs="$n" count=1 iflag=fullblock 2>/dev/null >>"$1.i"
    return
  fi
  while [ "$n" -gt 0 ]; do
    m=$(dd bs="$n" count=1 2>/dev/null | tee -a "$1.i" 2>/dev/null | wc -c) || m=0
    [ "$((m))" -gt 0 ] || exit 1
    n=$((n - m))
  done
}
writer <q &
exec 3>q
printf '\\n@GDR-HELLO 2\\n'
while read -r op id a b l c i; do
  case $op in
  D) recv "$id" "$a" ;;
  X) printf "$c" >"$id.c"; printf "$i" >>"$id.i"
     if [ "$l" != - ]; then
       n=$(wc -c 2>/dev/null <"$id.i") || n=-1
       [ "$((n))" = "$l" ] || : >"$id.z"
     fi
     # Without head -c, the client stops a command at its limit: it needs the output early.
     [ "$a" -gt 0 ] && [ -z "$hc" ] && b=1
     job "$id" "$a" "$b" & ;;
  K) [ -f "$id.c" ] || continue
     : >"$id.k"; p=; read -r p 2>/dev/null <"$id.p"
     if [ -n "$p" ]; then
       # The command and everything it started (e.g. git merge behind git pull): SIGTERM,
       # then SIGKILL for what is left after 3 seconds.
       t=$(tree "$p"); [ -n "$t" ] || t=$p
       for p in $t; do echo "$p $(ps -o comm= -p "$p" 2>/dev/null)"; done >"$id.t"
       kill $t 2>/dev/null
       (sleep 3; t=$(survivors "$id.t"); [ -n "$t" ] && kill -9 $t) 2>/dev/null &
     fi ;;
  esac
done
for p in *.p; do read -r k 2>/dev/null <"$p" && [ -n "$k" ] && kill "$k" 2>/dev/null; done
echo . >&3
exec 3>&-
wait
`;

/** Stdin up to this size goes inline in the request line (encoding costs up to 4x). */
const INLINE_STDIN = 4096;
/** Larger stdin is sent in pieces of this size. */
const STDIN_CHUNK = 256 * 1024;

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

export interface RunRequest {
  readonly stdin?: Stdin;
  /** Stdout beyond this many bytes is cut off (0: no limit). */
  readonly limit?: number;
  /** Send stdout while the command runs. */
  readonly stream?: boolean;
}

/** Builds the requests that run `command` (a shell script) on the runner. */
export const encodeRequest = (id: number, command: string, request: RunRequest = {}): Buffer => {
  const stdin =
    typeof request.stdin === "string" ? Buffer.from(request.stdin, "utf8") : request.stdin;
  const parts: Buffer[] = [];
  let length = "-";
  let inline = "";
  if (stdin && stdin.length > INLINE_STDIN) {
    for (let at = 0; at < stdin.length; at += STDIN_CHUNK) {
      const chunk = stdin.subarray(at, at + STDIN_CHUNK);
      parts.push(Buffer.from(`D ${id} ${chunk.length}\n`), chunk);
    }
    length = String(stdin.length);
  } else if (stdin && stdin.length > 0) {
    inline = ` ${encodePrintf(stdin)}`;
  }
  const flags = `${request.limit ?? 0} ${request.stream ? 1 : 0} ${length}`;
  parts.push(Buffer.from(`X ${id} ${flags} ${encodePrintf(command)}${inline}\n`, "latin1"));
  return Buffer.concat(parts);
};

export type RunnerEvent =
  | { readonly kind: "hello" }
  | { readonly kind: "output"; readonly id: number; readonly data: Buffer }
  | {
      readonly kind: "exit";
      readonly id: number;
      readonly exitCode: number;
      readonly stderr: Buffer;
    }
  | { readonly kind: "failed"; readonly id: number; readonly reason: string };

const HELLO = "@GDR-HELLO 2";
const MAX_HEADER = 256;
const HEADER_RE = /^@GDR (\d+) (?:O (\d+)|X (\d+) (\d+)|F (\w+))$/;

/** Incremental parser for the runner's output stream. */
export class ResponseParser {
  private greeted = false;
  private header: Buffer[] = [];
  private headerLength = 0;
  private frame: { id: number; exitCode: number | null; length: number } | null = null;
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
        // Before the greeting, long lines are noise to skip rather than an error.
        if (this.headerLength <= MAX_HEADER) this.header.push(chunk.subarray(off, end));
        this.headerLength += end - off;
        if (this.headerLength > MAX_HEADER && this.greeted) {
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
        const take = Math.min(this.frame.length - this.received, chunk.length - off);
        this.body.push(chunk.subarray(off, off + take));
        this.received += take;
        off += take;
        if (this.received === this.frame.length) this.endFrame();
      }
    }
  }

  private startFrame(line: string): void {
    if (!this.greeted) {
      if (line === HELLO) {
        this.greeted = true;
        this.onEvent({ kind: "hello" });
      }
      return;
    }
    const m = HEADER_RE.exec(line);
    if (!m) {
      this.fail(`Runner protocol error: unexpected ${JSON.stringify(line.slice(0, 80))}`);
      return;
    }
    const id = Number(m[1]);
    if (m[5] !== undefined) {
      this.onEvent({ kind: "failed", id, reason: m[5] });
      return;
    }
    const exitCode = m[3] === undefined ? null : Number(m[3]);
    this.frame = { id, exitCode, length: Number(m[2] ?? m[4]) };
    if (this.frame.length === 0) this.endFrame();
  }

  private endFrame(): void {
    const f = this.frame!;
    const body = Buffer.concat(this.body, f.length);
    this.frame = null;
    this.body = [];
    this.received = 0;
    this.onEvent(
      f.exitCode === null
        ? { kind: "output", id: f.id, data: body }
        : { kind: "exit", id: f.id, exitCode: f.exitCode, stderr: body },
    );
  }

  private fail(message: string): void {
    this.failed = true;
    this.onError(new Error(message));
  }
}

export interface RunnerResponse {
  /** Stdout, unless it was streamed (`onOutput`). */
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
  /** Stdout went beyond the limit and was cut off there. */
  readonly truncated: boolean;
}

/** A command's outcome, or the reason the runner lost it. */
export type RunnerResult = RunnerResponse | { readonly lost: string } | Error;

interface Pending {
  readonly limit: number;
  readonly onOutput: ((chunk: Buffer) => void) | undefined;
  callback: (result: RunnerResult) => void;
  readonly chunks: Buffer[];
  bytes: number;
}

const LOST: Readonly<Record<string, string>> = {
  input: "The runner could not store the command's input",
  output: "The runner could not read the command's output",
};

/** The runner process exited; for ssh, exit code 255 means the connection failed. */
export class RunnerExitError extends Error {
  constructor(
    readonly exitCode: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Client side of a runner process (see `RUNNER_SCRIPT`). */
export class Runner {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private error: Error | null = null;
  private stderr = "";
  private onHello: (() => void) | null;

  private constructor(
    private readonly child: ChildProcess,
    onHello: () => void,
  ) {
    this.onHello = onHello;
    const parser = new ResponseParser(
      (event) => this.onEvent(event),
      (error) => this.fail(error),
    );
    child.stdout!.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      // The end says why the runner failed; cancelled commands add noise before that.
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.stdin!.on("error", () => {
      // The exit handler reports the failure.
    });
    child.on("error", (e) => this.fail(e));
    child.on("close", (code, signal) =>
      this.fail(
        new RunnerExitError(code, `Runner exited with ${signal ?? code}${this.stderrSuffix()}`),
      ),
    );
  }

  /**
   * Starts a runner by spawning `file args`, which must run `RUNNER_SCRIPT` with
   * its stdin and stdout connected to ours. Interrupting kills the process.
   */
  static start(file: string, args: readonly string[]): Effect.Effect<Runner, Error> {
    return Effect.andThen(
      environmentReady,
      Effect.callback<Runner, Error>((resume) => {
        const child = nodeSpawn(file, args as string[], {
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
          windowsHide: true,
        });
        const runner: Runner = new Runner(child, () => resume(Effect.succeed(runner)));
        runner.onFailure = (e) => resume(Effect.fail(e));
        return Effect.sync(() => runner.close());
      }),
    );
  }

  /** Called once when the runner dies before saying hello. */
  private onFailure: ((e: Error) => void) | null = null;

  get alive(): boolean {
    return this.error === null;
  }

  /**
   * Runs `command`; `callback` receives the response or the runner's failure. With
   * `onOutput`, stdout is streamed to it instead of collected. Output beyond `limit` ends the
   * command early, with a truncated response.
   */
  run(
    command: string,
    request: RunRequest & { readonly onOutput?: (chunk: Buffer) => void },
    callback: (result: RunnerResult) => void,
  ): number {
    const id = this.nextId++;
    if (this.error) {
      callback(this.error);
      return id;
    }
    this.pending.set(id, {
      limit: request.limit ?? 0,
      onOutput: request.onOutput,
      callback,
      chunks: [],
      bytes: 0,
    });
    this.child.stdin!.write(
      encodeRequest(id, command, { ...request, stream: request.onOutput !== undefined }),
    );
    return id;
  }

  /**
   * Kills a running command; its callback is not called anymore. `onSettled` runs once the
   * command has exited (the runner still reports killed commands) or the runner is gone.
   */
  cancel(id: number, onSettled?: () => void): void {
    const p = this.pending.get(id);
    if (!p || this.error) {
      onSettled?.();
      return;
    }
    p.callback = () => onSettled?.();
    this.child.stdin!.write(`K ${id}\n`);
  }

  /** Ends the runner; the remote side kills running commands and cleans up. */
  close(): void {
    this.fail(new Error("Runner closed"));
  }

  private onEvent(event: RunnerEvent): void {
    if (event.kind === "hello") {
      this.onHello?.();
      this.onHello = null;
      this.onFailure = null;
      return;
    }
    const p = this.pending.get(event.id);
    if (!p) return;
    if (event.kind === "failed") {
      this.pending.delete(event.id);
      p.callback({ lost: LOST[event.reason] ?? `The runner lost the command (${event.reason})` });
      return;
    }
    if (event.kind === "output") {
      if (p.onOutput) {
        p.onOutput(event.data);
        return;
      }
      p.chunks.push(event.data);
      p.bytes += event.data.length;
      if (p.limit > 0 && p.bytes > p.limit) {
        // Enough: answer now, and stop the command if it still runs (without waiting for it).
        const callback = p.callback;
        this.cancel(event.id);
        callback({
          stdout: Buffer.concat(p.chunks).subarray(0, p.limit),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          truncated: true,
        });
      }
      return;
    }
    this.pending.delete(event.id);
    p.callback({
      stdout: Buffer.concat(p.chunks),
      stderr: event.stderr,
      exitCode: event.exitCode,
      truncated: false,
    });
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    this.onFailure?.(error);
    this.onFailure = null;
    this.onHello = null;
    for (const p of this.pending.values()) p.callback(error);
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
 * (`okCodes`, `maxBytes`, `onStdout`, interruption kills the command). A runner failure is
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
    readonly onStdout?: (chunk: Buffer) => void;
    readonly display: string;
  },
): Effect.Effect<SpawnResult, CommandError | SshError> =>
  Effect.callback<SpawnResult, CommandError | SshError>((resume) => {
    let sent = false;
    const request = { stdin: options.stdin, limit: options.maxBytes, onOutput: options.onStdout };
    const id = runner.run(command, request, (r) => {
      if (r instanceof Error) {
        // A runner that was already dead never received the command.
        resume(
          Effect.fail(
            new SshError({
              message: `Lost connection to ${host}`,
              host,
              stderr: r.message,
              mayHaveRun: sent,
            }),
          ),
        );
        return;
      }
      if ("lost" in r) {
        resume(
          Effect.fail(
            new CommandError({
              message: r.lost,
              command: options.display,
              exitCode: null,
              stderr: "",
            }),
          ),
        );
        return;
      }
      resume(
        completion(
          {
            stdout: r.stdout,
            stderr: r.stderr.subarray(0, MAX_STDERR).toString("utf8"),
            code: r.exitCode,
            truncated: r.truncated,
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
