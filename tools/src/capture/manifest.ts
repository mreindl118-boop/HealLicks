/**
 * Session manifest: machine-readable JSON plus a human-readable summary,
 * updated after every segment so a crash never loses bookkeeping.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureMode } from "./script.js";

export interface SegmentRecord {
  index: number;
  stepId: string;
  title: string;
  file: string | null;
  status: "captured" | "discarded" | "skipped" | "failed";
  attempts: number;
  messageCount: number;
  /** Non-heartbeat OSC address counts (Mode B) or packet counts (Mode A). */
  countsByAddress: Record<string, number>;
  startedAt: string;
  endedAt: string | null;
  userNote: string | null;
}

export interface SessionManifest {
  createdAt: string;
  finishedAt: string | null;
  mode: CaptureMode;
  modeLabel: string;
  device: {
    instanceName: string | null;
    host: string | null;
    updatePort: number | null;
    commandPort: number | null;
    model: string | null;
    firmware: string | null;
    productInfoRaw: unknown;
    discoveredVia: "mdns" | "manual";
  };
  environment: {
    platform: string;
    nodeVersion: string;
    captureTool: string;
  };
  baselineIdle: { messagesPerSecond: number | null; heartbeatIntervalMs: number | null };
  segments: SegmentRecord[];
  notes: string[];
}

export class ManifestWriter {
  readonly manifest: SessionManifest;
  readonly sessionDir: string;

  constructor(sessionDir: string, initial: SessionManifest) {
    this.sessionDir = sessionDir;
    this.manifest = initial;
    mkdirSync(join(sessionDir, "segments"), { recursive: true });
    this.flush();
  }

  addNote(note: string): void {
    this.manifest.notes.push(note);
    this.flush();
  }

  upsertSegment(record: SegmentRecord): void {
    const index = this.manifest.segments.findIndex(
      (s) => s.index === record.index && s.stepId === record.stepId && s.startedAt === record.startedAt,
    );
    if (index === -1) {
      this.manifest.segments.push(record);
    } else {
      this.manifest.segments[index] = record;
    }
    this.flush();
  }

  finish(): void {
    this.manifest.finishedAt = new Date().toISOString();
    this.flush();
    this.writeSummary();
  }

  flush(): void {
    writeFileSync(join(this.sessionDir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
  }

  private writeSummary(): void {
    const m = this.manifest;
    const lines: string[] = [];
    lines.push(`# Capture session summary`);
    lines.push("");
    lines.push(`- Started: ${m.createdAt}`);
    lines.push(`- Finished: ${m.finishedAt ?? "(incomplete)"}`);
    lines.push(`- Mode: ${m.mode} — ${m.modeLabel}`);
    lines.push(
      `- Device: ${m.device.model ?? "unknown model"} fw ${m.device.firmware ?? "unknown"} at ${m.device.host ?? "?"} (${m.device.discoveredVia})`,
    );
    if (m.baselineIdle.messagesPerSecond !== null) {
      lines.push(`- Idle baseline: ${m.baselineIdle.messagesPerSecond.toFixed(2)} msgs/s`);
    }
    if (m.baselineIdle.heartbeatIntervalMs !== null) {
      lines.push(`- Heartbeat interval: ~${Math.round(m.baselineIdle.heartbeatIntervalMs)}ms`);
    }
    lines.push("");
    lines.push(`| # | Step | Status | Attempts | Messages | File | Notable addresses |`);
    lines.push(`|---|------|--------|----------|----------|------|-------------------|`);
    for (const s of m.segments) {
      const notable = Object.entries(s.countsByAddress)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([addr, n]) => `${addr}×${n}`)
        .join(", ");
      lines.push(
        `| ${s.index} | ${s.title} | ${s.status} | ${s.attempts} | ${s.messageCount} | ${s.file ?? "-"} | ${notable || "-"} |`,
      );
    }
    lines.push("");
    if (m.notes.length > 0) {
      lines.push(`## Session notes`);
      for (const note of m.notes) lines.push(`- ${note}`);
      lines.push("");
    }
    lines.push(`## Next steps`);
    lines.push(`1. Diff adjacent segments to isolate per-action message signatures.`);
    lines.push(`2. Decode Mode A pcaps: \`npm run cli -- decode-pcap <segment.pcap>\``);
    lines.push(`   (or the community tool: \`python3 scripts/osc_pcap_dump.py --reassemble <segment.pcap>\`).`);
    lines.push(`3. Update PROTOCOL.md with confirmed/changed message shapes and the firmware version above.`);
    lines.push(`4. Regenerate mock fixtures from captured payloads (see mock/README notes in PROTOCOL.md).`);
    writeFileSync(join(this.sessionDir, "summary.md"), lines.join("\n"));
  }
}
