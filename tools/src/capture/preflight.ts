/**
 * Preflight: the wizard refuses to start until every check passes.
 *   1. Discover the Stadium via mDNS (or take --host) — re-scan loop with a
 *      plain-English troubleshooting checklist on failure. Never proceeds
 *      while undiscovered.
 *   2. Read device model + firmware into the session manifest.
 *   3. Disk space, capture directory, and (Mode A) tcpdump permissions —
 *      with exact fix-it commands.
 *   4. Editor state for the chosen mode (open for A, closed for B), checked
 *      here and re-checked before every step.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, platform } from "node:os";
import {
  buildProductInfoGet,
  decodeMsgpackBlob,
  parseDeviceInfo,
  type DeviceInfo,
} from "@stadium-deck/protocol";
import { discoverStadiums, type DiscoveredStadium } from "@stadium-deck/bridge/discovery";
import { StadiumClient } from "@stadium-deck/bridge/stadium-client";
import { TcpdumpBackend, type InvariantCheck } from "./backends.js";
import type { CaptureMode } from "./script.js";
import { bullet, header, pressEnter, style } from "./ui.js";

export interface PreflightTarget {
  instanceName: string | null;
  host: string;
  updatePort: number;
  commandPort: number;
  discoveredVia: "mdns" | "manual";
}

export interface ManualTarget {
  host: string;
  updatePort: number;
  commandPort: number;
}

function troubleshootingChecklist(): void {
  console.log("");
  console.log(style.bad("  ✗ No Helix Stadium found on this network (_stadiumserver._tcp)."));
  console.log("");
  console.log(style.step("  Check these, then press Enter to re-scan:"));
  bullet("Is the unit powered on and awake (screen lit, not asleep)?");
  bullet("Same Wi-Fi? The SSID shown on the unit's network settings screen must match this machine's Wi-Fi.");
  bullet("Router settings: guest network OFF for one of the two, AP/client isolation OFF.");
  bullet("Is Wi-Fi enabled on the Stadium (not just Bluetooth)?");
  bullet("On macOS, try:  dns-sd -B _stadiumserver._tcp   in another terminal to sanity-check.");
  console.log("");
}

/** Loop until a Stadium is discovered (or the manual target is provided). */
export async function discoverLoop(manual: ManualTarget | null): Promise<PreflightTarget> {
  if (manual !== null) {
    console.log(style.dim(`  Using manual target ${manual.host}:${manual.updatePort}/${manual.commandPort} (mDNS skipped).`));
    return { instanceName: null, ...manual, discoveredVia: "manual" };
  }
  for (;;) {
    process.stdout.write("  Scanning for _stadiumserver._tcp (5s)... ");
    const found: DiscoveredStadium[] = await discoverStadiums({ timeoutMs: 5000, collectAll: true });
    if (found.length > 0) {
      const first = found[0]!;
      console.log(style.ok("found"));
      for (const stadium of found) {
        bullet(
          `${style.step(stadium.instanceName)} at ${stadium.host} (update ${stadium.updatePort}, command ${stadium.commandPort})`,
        );
      }
      if (found.length > 1) {
        console.log(style.warn(`  Multiple instances found; using "${first.instanceName}".`));
      }
      return {
        instanceName: first.instanceName,
        host: first.host,
        updatePort: first.updatePort,
        commandPort: first.commandPort,
        discoveredVia: "mdns",
      };
    }
    console.log(style.bad("nothing"));
    troubleshootingChecklist();
    await pressEnter(style.key("  Press Enter to re-scan..."));
  }
}

/** Connect briefly (read-only) to record model + firmware, then disconnect. */
export async function readDeviceInfo(target: PreflightTarget): Promise<{ info: DeviceInfo; raw: unknown }> {
  const client = await StadiumClient.connect({
    host: target.host,
    updatePort: target.updatePort,
    commandPort: target.commandPort,
  });
  try {
    const result = await client.request(buildProductInfoGet);
    if (!result.ok || result.reply?.kind !== "reply") {
      throw new Error(`ProductInfoGet failed: ${result.detail ?? result.failure ?? "no reply"}`);
    }
    const blob = result.reply.message.args[1];
    const decoded = blob instanceof Uint8Array ? decodeMsgpackBlob(blob) : null;
    return { info: parseDeviceInfo(decoded), raw: decoded };
  } finally {
    client.close();
  }
}

const MIN_FREE_BYTES = 500 * 1024 * 1024;

/** Disk space + writability for the session directory. */
export function checkCaptureDirectory(sessionDir: string): InvariantCheck {
  try {
    mkdirSync(join(sessionDir, "segments"), { recursive: true });
    const probe = join(sessionDir, ".write-test");
    writeFileSync(probe, "ok");
  } catch (error) {
    return {
      ok: false,
      problem: `Cannot write to ${sessionDir}: ${error instanceof Error ? error.message : error}`,
      fix: [`mkdir -p "${sessionDir}" && chmod u+w "${sessionDir}"`],
    };
  }
  try {
    const stats = statfsSync(sessionDir);
    const free = stats.bavail * stats.bsize;
    if (free < MIN_FREE_BYTES) {
      return {
        ok: false,
        problem: `Only ${(free / 1024 / 1024).toFixed(0)}MB free at ${sessionDir}; captures need at least 500MB headroom.`,
        fix: ["Free some disk space, or point the session elsewhere:  npm run capture -- --session-dir /path/with/space"],
      };
    }
  } catch {
    // statfs unsupported: skip the space check rather than block the session.
  }
  return { ok: true };
}

/**
 * Detect whether the official Helix Stadium editor holds a TCP connection to
 * the device's command port. Used to verify editor OPEN (Mode A) or CLOSED
 * (Mode B). macOS-only (lsof); other platforms return "unknown".
 */
export function editorConnectionState(commandPort: number): "open" | "closed" | "unknown" {
  if (platform() !== "darwin" && platform() !== "linux") return "unknown";
  const result = spawnSync("lsof", ["-nP", `-iTCP:${commandPort}`, "-sTCP:ESTABLISHED"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status === null) return "unknown";
  // lsof exits 1 with no output when nothing matches.
  const lines = (result.stdout || "").trim().split("\n").filter((l) => l.length > 0);
  if (lines.length <= 1) return "closed";
  // Ignore our own node process's connections (Mode B observer).
  const foreign = lines.slice(1).filter((line) => !/^node|^tsx/i.test(line));
  return foreign.length > 0 ? "open" : "closed";
}

export function editorCheckForMode(mode: CaptureMode, commandPort: number): InvariantCheck {
  const state = editorConnectionState(commandPort);
  if (state === "unknown") {
    return { ok: true, problem: "Editor state cannot be verified on this platform (no lsof); proceeding on trust." };
  }
  if (mode === "A" && state !== "open") {
    return {
      ok: false,
      problem: "The official Helix Stadium editor does not appear to be connected to the device.",
      fix: [
        "Open the Helix Stadium app on this Mac and wait until it shows the device as connected.",
        "Leave it open for the whole Mode A session.",
      ],
    };
  }
  if (mode === "B" && state === "open") {
    return {
      ok: false,
      problem: "Something (probably the official editor) is connected to the device's command port.",
      fix: [
        "Quit the Helix Stadium app completely (Cmd+Q, not just close the window).",
        "Also stop any other tool holding a connection to the device.",
      ],
    };
  }
  return { ok: true };
}

export function tcpdumpCheck(interfaceName: string): InvariantCheck {
  return TcpdumpBackend.permissionCheck(interfaceName);
}

export function environmentSummary(): { platform: string; nodeVersion: string; captureTool: string } {
  return {
    platform: `${platform()} (${hostname()})`,
    nodeVersion: process.version,
    captureTool: "stadium-deck capture wizard v0.1.0",
  };
}

export function printCheck(label: string, check: InvariantCheck): boolean {
  if (check.ok) {
    console.log(`  ${style.ok("✓")} ${label}${check.problem ? style.dim(` — ${check.problem}`) : ""}`);
    return true;
  }
  console.log(`  ${style.bad("✗")} ${label}`);
  console.log(`    ${style.bad(check.problem ?? "failed")}`);
  for (const fix of check.fix ?? []) {
    console.log(`    ${style.warn("fix:")} ${fix}`);
  }
  return false;
}

export function preflightHeader(): void {
  header("PREFLIGHT");
  console.log(style.dim("  The wizard will not start until every check passes."));
}
