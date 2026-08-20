/**
 * scripts/hitl-log-file-tee-target.ts
 * The real (production) LogFileTeeTarget for hitl.ts's installLogFileTee() —
 * split into its own file so it can be excluded from the aggregate coverage
 * gate (scripts/check-coverage.ts's EXCLUDE_PREFIXES) without hiding any of
 * hitl.ts's actual pure logic from that gate.
 *
 * Every line in this file does nothing but read or reassign real global
 * state (process.stdout.write, process.stderr.write, console.log/warn/
 * error). That's the one piece of installLogFileTee()'s design that's
 * inherently impossible to exercise safely in-process — patching these
 * globals in the shared `bun test` process would leak into sibling suites,
 * which is exactly what this repo's isolation contract (see CLAUDE.md's Test
 * conventions) forbids. It's exercised for real via a subprocess fixture in
 * hitl.integration.test.ts instead.
 *
 * Mirrors the existing "process entrypoints" precedent in
 * check-coverage.ts's EXCLUDE_PREFIXES (e.g. admin/src/main.ts,
 * task-store/src/main.ts): a thin file whose only content is unavoidably
 * untestable wiring, with all the actual pure logic (createTeeWriter,
 * buildTeeConsoleMethod, createAppendLineSink, installLogFileTee's own
 * guard/sequencing) tested directly in hitl.ts / hitl.unit.test.ts via an
 * injected fake LogFileTeeTarget instead.
 */

/**
 * A stdout/stderr-shaped write function: takes a chunk (plus whatever
 * encoding/callback args Node's Writable#write overloads pass) and returns a
 * boolean (backpressure signal).
 */
export type WriteFn = (
  chunk: string | Uint8Array,
  ...args: unknown[]
) => boolean;

/** Console method name shape shared across hitl.ts's tee-wrapping helpers. */
export type ConsoleMethod = (...args: unknown[]) => void;

/**
 * Where installLogFileTee() reads the "original" functions from and writes
 * the teed replacements back to. Defaults to the real process.stdout/
 * process.stderr/console (realLogFileTeeTarget, below) — the only part of
 * installLogFileTee() that's inherently subprocess-only, since it touches
 * real global state. Tests inject a fake target instead (see
 * hitl.unit.test.ts), so everything else installLogFileTee() does — the
 * guard, building the sink, wrapping the originals via createTeeWriter()/
 * buildTeeConsoleMethod() — runs and is asserted on in-process, without ever
 * touching the real process/console. Mirrors hitl.ts's other
 * injected-dependency seams (runPreflight(steps, exec), startServices(spawn)).
 */
export type LogFileTeeTarget = {
  getStreamWrite: (stream: "stdout" | "stderr") => WriteFn;
  setStreamWrite: (stream: "stdout" | "stderr", fn: WriteFn) => void;
  getConsoleMethod: (method: "log" | "warn" | "error") => ConsoleMethod;
  setConsoleMethod: (
    method: "log" | "warn" | "error",
    fn: ConsoleMethod,
  ) => void;
};

/** stdout/stderr, addressable by the same "stdout"/"stderr" keys realLogFileTeeTarget's get/setStreamWrite take. */
const REAL_STREAMS = { stdout: process.stdout, stderr: process.stderr };

/** The real (production) LogFileTeeTarget — the sole subprocess-only piece. */
export const realLogFileTeeTarget: LogFileTeeTarget = {
  getStreamWrite: (stream) =>
    REAL_STREAMS[stream].write.bind(REAL_STREAMS[stream]),
  setStreamWrite: (stream, fn) => {
    REAL_STREAMS[stream].write = fn as typeof REAL_STREAMS.stdout.write;
  },
  getConsoleMethod: (method) => console[method].bind(console),
  setConsoleMethod: (method, fn) => {
    console[method] = fn;
  },
};
