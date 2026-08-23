/**
 * Capture backends behind one interface.
 *
 * Mode A (sniff): spawns tcpdump per segment writing a pcap of ports
 * 2001/2002 while the OFFICIAL editor is driven. Verification is
 * packet-level (tcpdump's "N packets captured" + file size).
 *
 * Mode B (observe): a read-only StadiumClient — ZMTP handshakes + SUBSCRIBE
 * only, never a control message — records decoded device broadcasts per
 * segment as NDJSON. Verification is exact OSC message counts by address.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { StadiumClient, type TrafficRecord } from "@stadium-deck/bridge/stadium-client";

export interface SegmentStats {
  /** OSC messages (Mode B) or captured packets (Mode A). */
  messageCount: number;
  /** Messages that are neither heartbeats nor idle noise. */
  actionMessageCount: number;
  countsByAddress: Record<string, number>;
  file: string | null;
}

export interface InvariantCheck {
  ok: boolean;
  problem?: string;
  fix?: string[];
}

export interface CaptureBackend {
  readonly kind: "sniff" | "observe";
  readonly unit: "packets" | "messages";
  startSegment(fileBase: string): Promise<void>;
  endSegment(): Promise<SegmentStats>;
  /** Live count so far in the open segment (for settle-gap quiet checks). */
  liveCount(): number;
  checkInvariant(): Promise<InvariantCheck>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Mode A — tcpdump sniffing
// ---------------------------------------------------------------------------

export interface TcpdumpOptions {
  segmentsDir: string;
  interfaceName: string;
  updatePort: number;
  commandPort: number;
  /** Function that checks the official editor still has its connection open. */
  editorCheck: () => Promise<InvariantCheck>;
}

export class TcpdumpBackend implements CaptureBackend {
  readonly kind = "sniff" as const;
  readonly unit = "packets" as const;
  private child: ChildProcess | null = null;
  private childExited: Promise<void> | null = null;
  private currentFile: string | null = null;
  private stderrBuf = "";

  constructor(private readonly options: TcpdumpOptions) {}

  /** Verify tcpdump exists and we may capture; returns fix-it commands otherwise. */
  static permissionCheck(interfaceName: string): InvariantCheck {
    const which = spawnSync("tcpdump", ["--version"], { encoding: "utf8" });
    if (which.error) {
      return {
        ok: false,
        problem: "tcpdump is not installed or not on PATH.",
        fix: ["macOS ships tcpdump at /usr/sbin/tcpdump — ensure /usr/sbin is on PATH, or install via brew."],
      };
    }
    const probe = spawnSync("tcpdump", ["-i", interfaceName, "-c", "0", "-w", "/dev/null"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (probe.status !== 0) {
      return {
        ok: false,
        problem: `tcpdump cannot capture on ${interfaceName} (${(probe.stderr || "permission denied").trim().split("\n")[0]})`,
        fix: [
          "Run the wizard with sudo:  sudo npm run capture",
          "or grant BPF access (survives reboots) by installing Wireshark's ChmodBPF:",
          "  brew install --cask wireshark   (includes the ChmodBPF helper)",
        ],
      };
    }
    return { ok: true };
  }

  async startSegment(fileBase: string): Promise<void> {
    if (this.child) throw new Error("segment already open");
    this.currentFile = join(this.options.segmentsDir, `${fileBase}.pcap`);
    this.stderrBuf = "";
    const filter = `tcp port ${this.options.updatePort} or tcp port ${this.options.commandPort}`;
    this.child = spawn(
      "tcpdump",
      ["-i", this.options.interfaceName, "-s", "0", "-U", "-w", this.currentFile, ...filter.split(" ")],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString();
    });
    // Register the exit promise NOW: if tcpdump dies mid-segment (disk full,
    // interface gone), a listener attached later would wait forever.
    const child = this.child;
    this.childExited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Give tcpdump a beat to attach before the user acts.
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (this.child.exitCode !== null) {
      const detail = this.stderrBuf.trim();
      this.child = null;
      throw new Error(`tcpdump exited immediately: ${detail}`);
    }
  }

  async endSegment(): Promise<SegmentStats> {
    const child = this.child;
    const exited = this.childExited;
    const file = this.currentFile;
    this.child = null;
    this.childExited = null;
    this.currentFile = null;
    if (!child || !exited || !file) throw new Error("no open segment");

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await exited;

    // tcpdump reports "N packets captured" on stderr at shutdown.
    const match = this.stderrBuf.match(/(\d+) packets? captured/);
    let packets = match ? Number.parseInt(match[1]!, 10) : 0;
    try {
      // An empty pcap is ~24 bytes (header only) — treat as zero even if the
      // summary line went missing.
      if (statSync(file).size <= 24) packets = 0;
    } catch {
      packets = 0;
    }
    return {
      messageCount: packets,
      actionMessageCount: packets,
      countsByAddress: { packets },
      file,
    };
  }

  liveCount(): number {
    // tcpdump gives no live count without a second reader; the settle-gap
    // check for Mode A relies on segment-level packet counts instead.
    return 0;
  }

  checkInvariant(): Promise<InvariantCheck> {
    return this.options.editorCheck();
  }

  async dispose(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Mode B — read-only observation
// ---------------------------------------------------------------------------

export interface ObserveOptions {
  segmentsDir: string;
  host: string;
  updatePort: number;
  commandPort: number;
}

export class ObserveBackend implements CaptureBackend {
  readonly kind = "observe" as const;
  readonly unit = "messages" as const;
  private client: StadiumClient | null = null;
  private stream: WriteStream | null = null;
  private currentFile: string | null = null;
  private counts = new Map<string, number>();
  private total = 0;
  private nonHeartbeat = 0;
  private downReason: string | null = null;

  constructor(private readonly options: ObserveOptions) {}

  async connect(): Promise<void> {
    this.client = await StadiumClient.connect({
      host: this.options.host,
      updatePort: this.options.updatePort,
      commandPort: this.options.commandPort,
      onTraffic: (record) => this.onTraffic(record),
      onDown: (reason) => {
        this.downReason = reason;
        this.client = null;
      },
    });
    this.downReason = null;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /** Used by the power-cycle step, which expects the link to drop and return. */
  async reconnectIfDown(): Promise<boolean> {
    if (this.client !== null) return true;
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  private onTraffic(record: TrafficRecord): void {
    if (record.direction !== "in") return;
    // Counters run whether or not a segment is open — the settle-gap quiet
    // check between segments depends on liveCount() still moving.
    this.total += 1;
    if (record.address !== "/heartbeat") this.nonHeartbeat += 1;
    this.counts.set(record.address, (this.counts.get(record.address) ?? 0) + 1);
    if (!this.stream) return;
    const entry = {
      iso: new Date(record.at).toISOString(),
      socket: record.socket,
      sequence: record.sequence ?? null,
      address: record.address,
      typeTags: record.typeTags,
      args: record.args.map((value) =>
        value instanceof Uint8Array
          ? { $blob: Buffer.from(value).toString("base64"), length: value.length }
          : typeof value === "bigint"
            ? { $i64: value.toString() }
            : value,
      ),
    };
    this.stream.write(`${JSON.stringify(entry)}\n`);
  }

  async startSegment(fileBase: string): Promise<void> {
    if (this.stream) throw new Error("segment already open");
    if (!this.client) throw new Error(`observer link is down${this.downReason ? `: ${this.downReason}` : ""}`);
    this.currentFile = join(this.options.segmentsDir, `${fileBase}.ndjson`);
    this.stream = createWriteStream(this.currentFile, { flags: "a" });
    this.counts = new Map();
    this.total = 0;
    this.nonHeartbeat = 0;
  }

  async endSegment(): Promise<SegmentStats> {
    const stream = this.stream;
    this.stream = null;
    const file = this.currentFile;
    this.currentFile = null;
    if (stream) await new Promise<void>((resolve) => stream.end(resolve));
    return {
      messageCount: this.total,
      actionMessageCount: this.nonHeartbeat,
      countsByAddress: Object.fromEntries(this.counts),
      file,
    };
  }

  liveCount(): number {
    return this.nonHeartbeat;
  }

  async checkInvariant(): Promise<InvariantCheck> {
    if (this.client === null) {
      return {
        ok: false,
        problem: `The read-only link to the Stadium dropped${this.downReason ? ` (${this.downReason})` : ""}.`,
        fix: [
          "Check the Stadium is still powered on and on the same Wi-Fi.",
          "The wizard will try to reconnect when you continue.",
        ],
      };
    }
    return { ok: true };
  }

  async dispose(): Promise<void> {
    this.stream?.end();
    this.stream = null;
    this.client?.close();
    this.client = null;
  }
}
