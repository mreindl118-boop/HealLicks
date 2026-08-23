/**
 * Stadium Deck bridge daemon.
 *
 * Discovers and holds the Stadium TCP link, serves the built PWA over HTTP,
 * and relays protocol messages over a same-origin WebSocket at /ws.
 *
 * Flags (env vars in parentheses):
 *   --port <n>                 (BRIDGE_PORT)          HTTP/WS port, default 8484
 *   --bind <addr>              (BRIDGE_BIND)          default 0.0.0.0
 *   --stadium-host <host>      (STADIUM_HOST)         skip mDNS, connect directly
 *   --stadium-update-port <n>  (STADIUM_UPDATE_PORT)  default 2001
 *   --stadium-command-port <n> (STADIUM_COMMAND_PORT) default 2002
 *   --allow-writes             (BRIDGE_ALLOW_WRITES=1) start with read-only OFF
 *   --no-traffic-log           (BRIDGE_TRAFFIC_LOG=0) disable traffic logging
 *   --verbose                  (BRIDGE_VERBOSE=1)
 */

import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createStaticHandler } from "./static-server.js";
import { PresetSnapshotter } from "./snapshots.js";
import { StadiumLink } from "./stadium-link.js";
import { TrafficLogger } from "./traffic-log.js";
import { WsRelay } from "./ws-server.js";
import { printPairingInfo } from "./qr.js";

const BRIDGE_VERSION = "0.1.0";

const config = loadConfig();
const log = (message: string): void => console.log(`[bridge] ${message}`);

// Defense in depth: the WS relay has its own error boundary, but a stray
// rejection elsewhere must degrade to a log line, not kill the daemon.
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED REJECTION (please report): ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`);
});
const verbose = (message: string): void => {
  if (config.verbose) log(message);
};

log(`Stadium Deck bridge v${BRIDGE_VERSION}`);
log(`read-only mode: ${config.readOnly ? "ON (writes refused until toggled in the app)" : "off"}`);

const trafficLogger = new TrafficLogger(config.logDir, config.trafficLogging);
if (config.trafficLogging) {
  log(`traffic log: ${trafficLogger.open()}`);
} else {
  log("traffic log: disabled");
}

const snapshotter = new PresetSnapshotter(config.snapshotDir, 10_000, log);

const link = new StadiumLink({
  ...(config.stadiumHost !== undefined
    ? {
        host: config.stadiumHost,
        updatePort: config.stadiumUpdatePort,
        commandPort: config.stadiumCommandPort,
      }
    : {}),
  onStatus: () => relay?.broadcastStatus(),
  onEvent: (event) => relay?.broadcastEvent(event),
  onTraffic: (record) => trafficLogger.write(record),
  log: verbose,
});

const httpServer = createServer(
  createStaticHandler({
    rootDir: config.appDist,
    healthz: () => ({
      bridge: { version: BRIDGE_VERSION, readOnly: relay?.readOnly ?? config.readOnly },
      stadium: link.status(),
      snapshots: snapshotter.snapshotCount,
      trafficLog: trafficLogger.filePath,
    }),
  }),
);

let relay: WsRelay | null = null;
relay = new WsRelay({
  httpServer,
  link,
  snapshotter,
  readOnly: config.readOnly,
  bridgeVersion: BRIDGE_VERSION,
  log: verbose,
});

httpServer.listen(config.port, config.bind, () => {
  log(`listening on ${config.bind}:${config.port} (app: ${config.appDist})`);
  printPairingInfo(config.port, console.log);
  if (config.stadiumHost !== undefined) {
    log(`stadium: connecting directly to ${config.stadiumHost}:${config.stadiumUpdatePort}/${config.stadiumCommandPort}`);
  } else {
    log("stadium: discovering via mDNS (_stadiumserver._tcp)...");
  }
  link.start();
});

async function shutdown(): Promise<void> {
  log("shutting down...");
  await link.stop();
  relay?.close();
  trafficLogger.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
