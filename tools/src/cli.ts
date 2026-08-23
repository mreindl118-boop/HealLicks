/**
 * CLI harness for protocol work. Experimental messages live HERE, never in
 * the app UI.
 *
 * Commands (run via `npm run cli -- <command> ...`):
 *   discover [--timeout <ms>]
 *   info     [--host <ip> [--update-port <n>] [--command-port <n>]]
 *   watch    [--host <ip> ...] [--seconds <n>]      read-only push monitor
 *   send     --address </X> --tags <ii...> --args '<json array>' [--expect </y>]
 *            EXPERIMENTAL raw send — the first tag must be i (cmdId, auto-filled)
 *   decode-pcap <file.pcap> [--json]
 */

import pc from "picocolors";
import {
  buildActiveSnapshotIndexGet,
  buildProductInfoGet,
  buildSnapshotCountGet,
  decodeMsgpackBlob,
  type OscValue,
} from "@stadium-deck/protocol";
import { discoverStadiums } from "@stadium-deck/bridge/discovery";
import { StadiumClient } from "@stadium-deck/bridge/stadium-client";
import { decodePcap, formatArg } from "./pcap.js";

const argv = process.argv.slice(2);
const command = argv[0];

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

async function resolveTarget(): Promise<{ host: string; updatePort: number; commandPort: number }> {
  const host = flagValue("--host");
  if (host !== undefined) {
    return {
      host,
      updatePort: Number.parseInt(flagValue("--update-port") ?? "2001", 10),
      commandPort: Number.parseInt(flagValue("--command-port") ?? "2002", 10),
    };
  }
  console.log("Discovering _stadiumserver._tcp...");
  const found = await discoverStadiums({ timeoutMs: 5000 });
  if (found.length === 0) {
    console.error(pc.red("No Stadium found via mDNS. Use --host <ip> (e.g. against the mock)."));
    process.exit(1);
  }
  const first = found[0]!;
  console.log(`Found "${first.instanceName}" at ${first.host} (${first.updatePort}/${first.commandPort})`);
  return { host: first.host, updatePort: first.updatePort, commandPort: first.commandPort };
}

async function withClient<T>(fn: (client: StadiumClient) => Promise<T>): Promise<T> {
  const target = await resolveTarget();
  const client = await StadiumClient.connect({
    ...target,
    onEvent: () => {},
  });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function printMessage(prefix: string, address: string, typeTags: string, args: readonly OscValue[]): void {
  console.log(`${prefix} ${pc.bold(address)} ,${typeTags} [${args.map(formatArg).join(", ")}]`);
}

switch (command) {
  case "discover": {
    const timeoutMs = Number.parseInt(flagValue("--timeout") ?? "5000", 10);
    const found = await discoverStadiums({ timeoutMs, collectAll: true });
    if (found.length === 0) {
      console.log("No _stadiumserver._tcp instances found.");
      process.exit(1);
    }
    for (const stadium of found) {
      console.log(`${pc.bold(stadium.instanceName)}`);
      console.log(`  host      : ${stadium.host} (${stadium.addresses.join(", ")})`);
      console.log(`  ports     : update ${stadium.updatePort}, command ${stadium.commandPort}`);
      console.log(`  txt       : ${stadium.txt ? JSON.stringify(stadium.txt) : "-"}`);
    }
    break;
  }

  case "info": {
    await withClient(async (client) => {
      const info = await client.request(buildProductInfoGet);
      if (info.ok && info.reply?.kind === "reply") {
        const blob = info.reply.message.args[1];
        console.log(pc.bold("Product info:"));
        console.log(JSON.stringify(blob instanceof Uint8Array ? decodeMsgpackBlob(blob) : null, null, 2));
      } else {
        console.log(pc.red(`ProductInfoGet failed: ${info.detail ?? info.failure}`));
      }
      const count = await client.request(buildSnapshotCountGet);
      if (count.ok && count.reply?.kind === "reply") {
        console.log(`Snapshots: ${String(count.reply.message.args[1])}`);
      }
      const active = await client.request(buildActiveSnapshotIndexGet);
      if (active.ok && active.reply?.kind === "reply") {
        console.log(`Active snapshot index: ${String(active.reply.message.args[1])}`);
      }
    });
    break;
  }

  case "watch": {
    const seconds = Number.parseInt(flagValue("--seconds") ?? "60", 10);
    const target = await resolveTarget();
    console.log(`Watching pushes for ${seconds}s (read-only; Ctrl+C to stop)...`);
    const client = await StadiumClient.connect({
      ...target,
      onEvent: (event) => {
        const stamp = new Date().toISOString().slice(11, 23);
        const seq = "sequence" in event.reply && event.reply.sequence !== undefined ? ` seq=${event.reply.sequence}` : "";
        printMessage(
          `${pc.dim(stamp)} ${event.source === "update" ? pc.cyan("push") : pc.yellow("cmd ")}${seq}`,
          event.reply.message.address,
          event.reply.message.typeTags,
          event.reply.message.args,
        );
      },
      onDown: (reason) => {
        console.log(pc.red(`link down: ${reason}`));
        process.exit(1);
      },
    });
    setTimeout(() => {
      client.close();
      process.exit(0);
    }, seconds * 1000);
    break;
  }

  case "send": {
    const address = flagValue("--address");
    const tags = flagValue("--tags");
    const argsJson = flagValue("--args") ?? "[]";
    const expect = flagValue("--expect");
    if (!address || !tags || !tags.startsWith("i")) {
      console.error("send requires --address </X> and --tags <i...> (first tag is the auto-filled cmdId)");
      process.exit(1);
    }
    console.log(pc.yellow("EXPERIMENTAL raw send — use a spare preset; this bypasses all validation."));
    const parsed = JSON.parse(argsJson) as unknown[];
    const args: OscValue[] = parsed.map((value) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : String(value),
    );
    await withClient(async (client) => {
      const result = await client.sendRaw(address, tags, args, expect);
      if (result.ok && result.reply) {
        printMessage(pc.green("reply"), result.reply.message.address, result.reply.message.typeTags, result.reply.message.args);
      } else {
        console.log(pc.red(`failed: ${result.failure} ${result.detail ?? ""}`));
      }
    });
    break;
  }

  case "decode-pcap": {
    const file = argv[1];
    if (!file) {
      console.error("usage: decode-pcap <file.pcap> [--json]");
      process.exit(1);
    }
    const messages = decodePcap(file, [2001, 2002], (warning) => console.error(pc.yellow(`warn: ${warning}`)));
    if (argv.includes("--json")) {
      console.log(
        JSON.stringify(
          messages.map((m) => ({
            t: m.timestamp,
            dir: m.direction,
            port: m.port,
            seq: m.sequence,
            address: m.message.address,
            typeTags: m.message.typeTags,
            args: m.message.args.map((a) =>
              a instanceof Uint8Array ? { $blob: Buffer.from(a).toString("base64") } : typeof a === "bigint" ? { $i64: a.toString() } : a,
            ),
          })),
          null,
          2,
        ),
      );
    } else {
      for (const m of messages) {
        const stamp = new Date(m.timestamp * 1000).toISOString().slice(11, 23);
        const dir = m.direction === "editor->device" ? pc.yellow("->dev") : pc.cyan("dev->");
        printMessage(`${pc.dim(stamp)} ${dir}:${m.port}`, m.message.address, m.message.typeTags, m.message.args);
      }
      console.log(pc.dim(`${messages.length} OSC messages decoded.`));
    }
    break;
  }

  default:
    console.log("commands: discover | info | watch | send | decode-pcap  (see file header for flags)");
    process.exit(command === undefined || command === "help" ? 0 : 1);
}
