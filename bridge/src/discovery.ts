/**
 * Bonjour/mDNS discovery of the Stadium.
 *
 * The device advertises `_stadiumserver._tcp`. The advertised service port is
 * the update/subscribe stream; the command port is the adjacent port + 1
 * (matching the reference tooling's behaviour when resolving discovered
 * devices). A manual host override skips discovery entirely.
 */

import { Bonjour, type Service } from "bonjour-service";
import { DEFAULT_COMMAND_PORT, DEFAULT_UPDATE_PORT } from "@stadium-deck/protocol";

export interface DiscoveredStadium {
  instanceName: string;
  host: string;
  addresses: string[];
  updatePort: number;
  commandPort: number;
  txt: Record<string, unknown> | null;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Resolve with every instance found instead of just the first. */
  collectAll?: boolean;
}

const SERVICE_TYPE = "stadiumserver";

function toDiscovered(service: Service): DiscoveredStadium {
  const ipv4 = (service.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const host = ipv4[0] ?? service.host ?? "";
  const updatePort = service.port ?? DEFAULT_UPDATE_PORT;
  return {
    instanceName: service.name ?? "unknown",
    host,
    addresses: service.addresses ?? [],
    updatePort,
    commandPort: updatePort === DEFAULT_UPDATE_PORT ? DEFAULT_COMMAND_PORT : updatePort + 1,
    txt: (service.txt as Record<string, unknown> | undefined) ?? null,
  };
}

/** Browse for Stadium instances. Resolves [] on timeout (never rejects). */
export function discoverStadiums(options: DiscoverOptions = {}): Promise<DiscoveredStadium[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found: DiscoveredStadium[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.stop();
      bonjour.destroy();
      resolve(found);
    };

    const timer = setTimeout(finish, timeoutMs);
    const browser = bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" }, (service: Service) => {
      const discovered = toDiscovered(service);
      if (discovered.host !== "") {
        found.push(discovered);
        if (!options.collectAll) finish();
      }
    });
  });
}

export async function discoverFirstStadium(timeoutMs = 5000): Promise<DiscoveredStadium | null> {
  const all = await discoverStadiums({ timeoutMs });
  return all[0] ?? null;
}
