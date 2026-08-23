/**
 * Structured traffic logging: newline-delimited JSON records written to
 * timestamped files under the log directory. Toggleable at runtime (the
 * capture wizard flips it per segment). Blob arguments are logged as base64
 * with their length so records stay one line each.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { TrafficRecord } from "./stadium-client.js";

export interface TrafficLogRecord extends Omit<TrafficRecord, "args"> {
  args: unknown[];
  iso: string;
  /** Optional segment label injected by the capture wizard. */
  segment?: string;
}

function serializeArgs(args: TrafficRecord["args"]): unknown[] {
  return args.map((value) => {
    if (value instanceof Uint8Array) {
      return { $blob: Buffer.from(value).toString("base64"), length: value.length };
    }
    if (typeof value === "bigint") {
      return { $i64: value.toString() };
    }
    return value;
  });
}

export class TrafficLogger {
  private stream: WriteStream | null = null;
  private currentSegment: string | null = null;
  enabled: boolean;
  readonly directory: string;
  filePath: string | null = null;
  recordCount = 0;

  constructor(directory: string, enabled = true) {
    this.directory = directory;
    this.enabled = enabled;
  }

  /** Open a new timestamped log file (closes any previous one). */
  open(labelSuffix = ""): string {
    this.close();
    mkdirSync(this.directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = labelSuffix ? `traffic-${stamp}-${labelSuffix}.ndjson` : `traffic-${stamp}.ndjson`;
    this.filePath = join(this.directory, name);
    this.stream = createWriteStream(this.filePath, { flags: "a" });
    this.recordCount = 0;
    return this.filePath;
  }

  setSegment(label: string | null): void {
    this.currentSegment = label;
  }

  write(record: TrafficRecord): void {
    if (!this.enabled || !this.stream) return;
    const entry: TrafficLogRecord = {
      ...record,
      args: serializeArgs(record.args),
      iso: new Date(record.at).toISOString(),
    };
    if (this.currentSegment !== null) entry.segment = this.currentSegment;
    this.stream.write(`${JSON.stringify(entry)}\n`);
    this.recordCount += 1;
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
