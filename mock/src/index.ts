/**
 * CLI entry: `npm run mock` (or with flags: `npm run mock -- --mdns --verbose`).
 *
 * Flags:
 *   --host <ip>            bind address (default 127.0.0.1; use 0.0.0.0 for LAN)
 *   --update-port <n>      device->editor stream port (default 2001)
 *   --command-port <n>     editor->device command port (default 2002)
 *   --heartbeat-ms <n>     heartbeat cadence (default 1000)
 *   --mdns                 advertise _stadiumserver._tcp via Bonjour
 *   --name <instance>      Bonjour instance name (default p35x1-mock)
 *   --verbose              log every request/reply
 */

import { MockStadium } from "./server.js";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function intFlag(name: string): number | undefined {
  const raw = flagValue(name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    console.error(`invalid value for ${name}: ${raw}`);
    process.exit(1);
  }
  return value;
}

const options: ConstructorParameters<typeof MockStadium>[0] = {
  mdns: process.argv.includes("--mdns"),
  verbose: process.argv.includes("--verbose"),
};
const host = flagValue("--host");
if (host !== undefined) options.host = host;
const updatePort = intFlag("--update-port");
if (updatePort !== undefined) options.updatePort = updatePort;
const commandPort = intFlag("--command-port");
if (commandPort !== undefined) options.commandPort = commandPort;
const heartbeatMs = intFlag("--heartbeat-ms");
if (heartbeatMs !== undefined) options.heartbeatMs = heartbeatMs;
const name = flagValue("--name");
if (name !== undefined) options.instanceName = name;

const mock = new MockStadium(options);
const { updatePort: up, commandPort: cp } = await mock.start();
console.log(`Mock Helix Stadium XL`);
console.log(`  update stream : ${mock.host}:${up}`);
console.log(`  command socket: ${mock.host}:${cp}`);
console.log(`  heartbeat     : every ${mock.heartbeatMs}ms`);
console.log(`  device        : ${mock.device.model} fw ${mock.device.firmware}`);
console.log(`Press Ctrl+C to stop.`);

process.on("SIGINT", () => {
  void mock.stop().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void mock.stop().then(() => process.exit(0));
});
