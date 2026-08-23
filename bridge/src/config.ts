/**
 * Bridge configuration from environment variables and CLI flags
 * (flags win). Everything has a safe default; the daemon starts read-only.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgeConfig {
  /** HTTP + WS listen port. */
  port: number;
  /** Bind address; 0.0.0.0 exposes the bridge on the LAN (required for the iPad). */
  bind: string;
  /** Manual Stadium host (skips mDNS discovery); undefined = discover. */
  stadiumHost: string | undefined;
  stadiumUpdatePort: number;
  stadiumCommandPort: number;
  /** Serve the built app from this directory. */
  appDist: string;
  logDir: string;
  snapshotDir: string;
  trafficLogging: boolean;
  readOnly: boolean;
  verbose: boolean;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

function intOption(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0 || value > 65535) {
    throw new Error(`invalid ${label}: ${raw}`);
  }
  return value;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env): BridgeConfig {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // Works from both src/ (tsx) and dist/ (node): bridge/<src|dist>/config.* -> repo root.
  const repoRoot = resolve(moduleDir, "..", "..");
  const bridgeRoot = resolve(moduleDir, "..");

  const stadiumHost = flagValue(argv, "--stadium-host") ?? env["STADIUM_HOST"];
  return {
    port: intOption(flagValue(argv, "--port") ?? env["BRIDGE_PORT"], 8484, "port"),
    bind: flagValue(argv, "--bind") ?? env["BRIDGE_BIND"] ?? "0.0.0.0",
    stadiumHost: stadiumHost === "" ? undefined : stadiumHost,
    stadiumUpdatePort: intOption(
      flagValue(argv, "--stadium-update-port") ?? env["STADIUM_UPDATE_PORT"],
      2001,
      "stadium update port",
    ),
    stadiumCommandPort: intOption(
      flagValue(argv, "--stadium-command-port") ?? env["STADIUM_COMMAND_PORT"],
      2002,
      "stadium command port",
    ),
    appDist: flagValue(argv, "--app-dist") ?? env["APP_DIST"] ?? join(repoRoot, "app", "dist"),
    logDir: flagValue(argv, "--log-dir") ?? env["BRIDGE_LOG_DIR"] ?? join(bridgeRoot, "logs"),
    snapshotDir:
      flagValue(argv, "--snapshot-dir") ?? env["BRIDGE_SNAPSHOT_DIR"] ?? join(bridgeRoot, "snapshots"),
    trafficLogging: !argv.includes("--no-traffic-log") && env["BRIDGE_TRAFFIC_LOG"] !== "0",
    readOnly: !argv.includes("--allow-writes") && env["BRIDGE_ALLOW_WRITES"] !== "1",
    verbose: argv.includes("--verbose") || env["BRIDGE_VERBOSE"] === "1",
  };
}
