/**
 * Safety rail: before any preset-modifying operation, snapshot the affected
 * state to the bridge's disk (timestamped JSON, restorable by replaying the
 * captured content data). Throttled so knob streams don't write a file per
 * message — one snapshot per preset per throttle window is enough to restore
 * "what it looked like before I started tweaking".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROPERTY_KEYS,
  buildEditBufferStateGet,
  buildGetContentData,
  buildPropertyValueGet,
  decodeMsgpackBlob,
  decodePropertyBlob,
  type BlobValue,
} from "@stadium-deck/protocol";
import type { StadiumLink } from "./stadium-link.js";

function blobArg(args: readonly unknown[], index: number): Uint8Array | null {
  const value = args[index];
  return value instanceof Uint8Array ? value : null;
}

export class PresetSnapshotter {
  private lastSnapshotAt = 0;
  private snapshotting = false;
  snapshotCount = 0;

  constructor(
    readonly directory: string,
    readonly throttleMs = 10_000,
    private readonly log?: (message: string) => void,
  ) {}

  /**
   * Fetch active preset id + edit buffer + preset content data and write them
   * to a timestamped snapshot file. Never throws; a failed snapshot logs a
   * warning but does not block the user's edit (the edit was user-initiated
   * and refusing it here would be more surprising than a missing backup).
   */
  async snapshotBeforeMutation(link: StadiumLink, triggerAddress: string): Promise<void> {
    const now = Date.now();
    if (this.snapshotting || now - this.lastSnapshotAt < this.throttleMs) return;
    this.snapshotting = true;
    try {
      const presetIdResult = await link.request((cmdId) =>
        buildPropertyValueGet(cmdId, PROPERTY_KEYS.activePresetId),
      );
      let activePresetId: BlobValue = null;
      if (presetIdResult.ok && presetIdResult.reply?.kind === "reply") {
        const blob = blobArg(presetIdResult.reply.message.args, 2);
        activePresetId = blob ? decodePropertyBlob(blob) : null;
      }

      const editBufferResult = await link.request(buildEditBufferStateGet);
      let editBuffer: BlobValue = null;
      if (editBufferResult.ok && editBufferResult.reply?.kind === "reply") {
        const blob = blobArg(editBufferResult.reply.message.args, 2);
        editBuffer = blob ? decodeMsgpackBlob(blob) : null;
      }

      let contentData: string | null = null;
      const presetCid = extractPresetCid(activePresetId);
      if (presetCid !== null) {
        const dataResult = await link.request((cmdId) => buildGetContentData(cmdId, presetCid));
        if (dataResult.ok && dataResult.reply?.kind === "reply") {
          const blob = blobArg(dataResult.reply.message.args, 1);
          contentData = blob ? Buffer.from(blob).toString("base64") : null;
        }
      }

      if (editBuffer === null && contentData === null) {
        this.log?.(`snapshot: skipped (no state readable before ${triggerAddress})`);
        return;
      }

      mkdirSync(this.directory, { recursive: true });
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      const path = join(this.directory, `preset-${stamp}.json`);
      writeFileSync(
        path,
        JSON.stringify(
          {
            takenAt: new Date(now).toISOString(),
            trigger: triggerAddress,
            activePresetId: serializable(activePresetId),
            presetCid,
            editBuffer: serializable(editBuffer),
            /** Raw /GetContentData blob (base64) — restorable via /SetContentData. */
            contentDataBase64: contentData,
          },
          null,
          2,
        ),
      );
      this.lastSnapshotAt = now;
      this.snapshotCount += 1;
      this.log?.(`snapshot: wrote ${path} (before ${triggerAddress})`);
    } catch (error) {
      this.log?.(`snapshot: FAILED before ${triggerAddress}: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.snapshotting = false;
    }
  }
}

function extractPresetCid(decoded: BlobValue): number | null {
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array) {
    return null;
  }
  const value = decoded["val_"] ?? decoded["val"];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function serializable(value: BlobValue): unknown {
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return { $i64: value.toString() };
  if (Array.isArray(value)) return value.map(serializable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializable(v)]));
  }
  return value;
}
