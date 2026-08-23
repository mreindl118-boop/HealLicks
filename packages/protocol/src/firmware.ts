/**
 * Firmware/compatibility detection.
 *
 * The protocol is unofficial and may change with firmware updates, so the
 * bridge records the device's reported product info at connect time and
 * compares it against the versions this codebase was validated against.
 * A mismatch downgrades to a loud warning — diagnosable, not fatal.
 */

import type { BlobValue } from "./blobs.js";

export interface DeviceInfo {
  /** Raw decoded /getProductInfo payload (shape may vary by firmware). */
  raw: BlobValue | null;
  model: string | null;
  firmwareVersion: string | null;
}

/**
 * Firmware versions this code has been validated against. Empty until the
 * first hardware capture session; update after every session (see CLAUDE.md).
 */
export const VALIDATED_FIRMWARE_VERSIONS: readonly string[] = [];

/** Envelope version observed on the port-2001 wrapper for validated firmware. */
export const VALIDATED_ENVELOPE_VERSION = 0x0108;

function findFirstKey(value: BlobValue, keys: readonly string[]): BlobValue {
  const queue: BlobValue[] = [value];
  while (queue.length > 0) {
    const current = queue.shift() ?? null;
    if (current === null) continue;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (typeof current === "object" && !(current instanceof Uint8Array)) {
      for (const key of keys) {
        const hit = (current as { [k: string]: BlobValue })[key];
        if (hit !== undefined && typeof hit === "string") return hit;
      }
      queue.push(...Object.values(current as { [k: string]: BlobValue }));
    }
  }
  return null;
}

/**
 * Extract model/firmware from a decoded product-info payload. Key names are a
 * best guess pending the first live capture; unknown shapes yield nulls plus
 * the raw payload for logging.
 */
export function parseDeviceInfo(raw: BlobValue | null): DeviceInfo {
  if (raw === null) return { raw, model: null, firmwareVersion: null };
  const model = findFirstKey(raw, ["model", "name", "product", "prod"]);
  const firmware = findFirstKey(raw, ["firmware", "fw", "version", "vers"]);
  return {
    raw,
    model: typeof model === "string" ? model : null,
    firmwareVersion: typeof firmware === "string" ? firmware : null,
  };
}

export interface CompatibilityReport {
  compatible: "validated" | "unknown" | "untested-firmware";
  warnings: string[];
}

export function checkCompatibility(info: DeviceInfo): CompatibilityReport {
  const warnings: string[] = [];
  if (info.firmwareVersion === null) {
    warnings.push(
      "Could not determine firmware version from product info; protocol behaviour is unverified for this device.",
    );
    return { compatible: "unknown", warnings };
  }
  if (VALIDATED_FIRMWARE_VERSIONS.length === 0) {
    warnings.push(
      `Device firmware ${info.firmwareVersion}: no validated firmware list yet (pre-capture phase). Proceeding read-only is safe; treat write paths as unverified.`,
    );
    return { compatible: "unknown", warnings };
  }
  if (!VALIDATED_FIRMWARE_VERSIONS.includes(info.firmwareVersion)) {
    warnings.push(
      `Device firmware ${info.firmwareVersion} has not been validated against this build (validated: ${VALIDATED_FIRMWARE_VERSIONS.join(", ")}). Protocol messages may have changed; prefer read-only until re-validated.`,
    );
    return { compatible: "untested-firmware", warnings };
  }
  return { compatible: "validated", warnings };
}
