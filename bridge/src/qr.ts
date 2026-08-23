/**
 * First-run pairing: print the bridge's LAN URL and render it as a terminal
 * QR code so the iPad can open it straight from the camera.
 */

import { networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";

/** Best-guess LAN IPv4 addresses (excludes loopback and internal interfaces). */
export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

export function printPairingInfo(port: number, log: (line: string) => void): string {
  const hosts = lanAddresses();
  const primary = hosts[0] ?? "localhost";
  const url = `http://${primary}:${port}/`;

  log("");
  log("  Open Stadium Deck on your iPad (same Wi-Fi):");
  for (const host of hosts.length > 0 ? hosts : ["localhost"]) {
    log(`    http://${host}:${port}/`);
  }
  log("");
  log("  Scan with the iPad camera, then Share -> Add to Home Screen:");
  qrcode.generate(url, { small: true }, (code: string) => {
    for (const line of code.split("\n")) log(`  ${line}`);
  });
  return url;
}
