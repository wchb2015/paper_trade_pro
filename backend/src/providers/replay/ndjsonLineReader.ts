import fs from "node:fs";
import readline from "node:readline";

// -----------------------------------------------------------------------------
// NDJSON line reader — wraps Node's readline.Interface with a pull-based
// `next()` so the scheduler can advance one trade at a time without buffering
// the whole file in memory.
//
// This is essentially a hand-rolled async iterator with a peek buffer, which
// the merge-heap in ReplayProvider needs: we must look at the head timestamp
// of each symbol's stream before deciding which one to emit next.
// -----------------------------------------------------------------------------

export interface LineReader {
  /** Resolves to the next JSON-parsed line, or null at EOF. */
  next(): Promise<unknown | null>;
  /** Close the underlying file handle. Idempotent. */
  close(): Promise<void>;
}

/**
 * Open an NDJSON file for line-by-line async reading.
 *
 * `rl.once('line')` is a pull primitive that emits one line per request;
 * we pause/resume the stream so we don't buffer.
 */
export function openNdjson(filePath: string): LineReader {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let closed = false;
  let ended = false;
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;

  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
      // Backpressure: pause once we have a line buffered. next() will resume.
      rl.pause();
    }
  });

  rl.on("close", () => {
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });

  rl.on("error", () => {
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });

  async function nextLine(): Promise<string | null> {
    if (closed) return null;
    if (queue.length > 0) {
      const line = queue.shift()!;
      // Resume consuming now that the buffer is empty.
      if (!ended) rl.resume();
      return line;
    }
    if (ended) return null;
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
      rl.resume();
    });
  }

  return {
    async next(): Promise<unknown | null> {
      // Skip empty lines defensively.
      while (true) {
        const line = await nextLine();
        if (line === null) return null;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          return JSON.parse(trimmed);
        } catch {
          // Ignore malformed line rather than kill the whole replay.
          continue;
        }
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      rl.close();
      fileStream.destroy();
    },
  };
}
