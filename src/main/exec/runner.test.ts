/** The runner protocol; `runner.*.test.ts` run the runner script under each shell. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePrintf, encodeRequest, ResponseParser, type RunnerEvent } from "./runner";

const output = (id: number, data: string | Buffer) => {
  const b = Buffer.from(data);
  return Buffer.concat([Buffer.from(`@GDR ${id} O ${b.length}\n`), b]);
};
const exit = (id: number, code: number, err = "") =>
  Buffer.from(`@GDR ${id} X ${code} ${Buffer.byteLength(err)}\n${err}`);

const parse = (chunks: Buffer[]) => {
  const events: RunnerEvent[] = [];
  const errors: Error[] = [];
  const parser = new ResponseParser(
    (e) => events.push(e),
    (e) => errors.push(e),
  );
  for (const c of chunks) parser.push(c);
  return { events, errors };
};

const simplify = (events: RunnerEvent[]) =>
  events.map((e) =>
    e.kind === "output"
      ? `${e.id} out ${e.data.toString()}`
      : e.kind === "exit"
        ? `${e.id} exit ${e.exitCode} ${e.stderr.toString()}`
        : e.kind === "failed"
          ? `${e.id} failed ${e.reason}`
          : "hello",
  );

describe("ResponseParser", () => {
  const stream = Buffer.concat([
    // A chatty login shell, before the runner starts.
    Buffer.from(`Welcome!\n@GDR 1 X 0 0\n${"=".repeat(1000)}\n@GDR-HELLO 2\n`),
    output(1, "hello\n"),
    output(2, "@GDR 9 X 9 9\n"),
    output(1, "world\n"),
    exit(1, 0, "warn\n"),
    exit(2, 128, "fatal: bad\n"),
    exit(3, 0),
    Buffer.from("@GDR 4 F input\n"),
  ]);
  const expected = [
    "hello",
    "1 out hello\n",
    "2 out @GDR 9 X 9 9\n",
    "1 out world\n",
    "1 exit 0 warn\n",
    "2 exit 128 fatal: bad\n",
    "3 exit 0 ",
    "4 failed input",
  ];

  it("parses a stream in one chunk, ignoring what comes before the greeting", () => {
    const { events, errors } = parse([stream]);
    expect(errors).toEqual([]);
    expect(simplify(events)).toEqual(expected);
  });

  it("parses a stream split at every byte boundary", () => {
    for (let at = 1; at < stream.length; at++) {
      const { events, errors } = parse([stream.subarray(0, at), stream.subarray(at)]);
      expect(errors).toEqual([]);
      expect(simplify(events)).toEqual(expected);
    }
    const { events } = parse([...stream].map((b) => Buffer.from([b])));
    expect(simplify(events)).toEqual(expected);
  });

  it("keeps binary output intact", () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { events } = parse([Buffer.from("@GDR-HELLO 2\n"), output(7, bin)]);
    expect(events[1]).toMatchObject({ kind: "output", id: 7 });
    expect((events[1] as { data: Buffer }).data.equals(bin)).toBe(true);
  });

  it("rejects garbage after the greeting", () => {
    const hello = Buffer.from("@GDR-HELLO 2\n");
    expect(parse([hello, Buffer.from("bash: oops\n")]).errors).toHaveLength(1);
    expect(parse([hello, Buffer.alloc(1000, 0x41)]).errors).toHaveLength(1);
    expect(parse([hello, Buffer.from("@GDR 1 O x\n")]).errors).toHaveLength(1);
    const { events, errors } = parse([hello, exit(1, 0), Buffer.from("junk\n"), exit(2, 0)]);
    expect(simplify(events)).toEqual(["hello", "1 exit 0 "]);
    expect(errors).toHaveLength(1);
  });
});

describe("encodePrintf", () => {
  it("uses only printable, space-free ASCII", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(encodePrintf(all)).toMatch(/^[\x21-\x7e]+$/);
    expect(encodePrintf("a b\n%\\")).toBe("a\\040b\\012%%\\\\");
    expect(encodePrintf("-n")).toBe("\\055n");
  });

  it("round-trips through the shell's printf", () => {
    const shells = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((s) => existsSync(s));
    const samples = [
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.from("\x000123\n\x01\x07 -v x %s %% \\n \\0101 'q' \"dq\" $HOME `id` é"),
      Buffer.from("-v"),
    ];
    for (const sh of shells) {
      for (const s of samples) {
        const out = execFileSync(sh, ["-c", 'printf "$1"', "sh", encodePrintf(s)]);
        expect(out.equals(s), `${sh}: ${JSON.stringify(s.toString())}`).toBe(true);
      }
    }
  });
});

describe("encodeRequest", () => {
  it("builds request lines with small stdin inline", () => {
    expect(encodeRequest(3, "git log").toString()).toBe("X 3 0 0 - git\\040log\n");
    expect(encodeRequest(4, "cat", { stdin: "a\0b", limit: 10 }).toString()).toBe(
      "X 4 10 0 - cat a\\000b\n",
    );
    expect(encodeRequest(5, "cat", { stdin: "", stream: true }).toString()).toBe("X 5 0 1 - cat\n");
  });

  it("sends large stdin raw, in pieces, before the command", () => {
    const stdin = Buffer.alloc(600 * 1024, 0x0a);
    const req = encodeRequest(6, "cat", { stdin });
    const piece = (n: number) => Buffer.concat([Buffer.from(`D 6 ${n}\n`), Buffer.alloc(n, 0x0a)]);
    expect(
      req.equals(
        Buffer.concat([
          piece(256 * 1024),
          piece(256 * 1024),
          piece(88 * 1024),
          Buffer.from(`X 6 0 0 ${stdin.length} cat\n`),
        ]),
      ),
    ).toBe(true);
  });
});
