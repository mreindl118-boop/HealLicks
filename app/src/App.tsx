/**
 * Phase 0 shell: always-visible connection status with distinct states for
 * "bridge unreachable" vs "bridge up, Stadium offline", the READ-ONLY
 * toggle safety rail, and device/firmware info. The live board lands here
 * in Phase 1.
 */

import { useAppStore } from "./store.js";
import { setReadOnly } from "./ws-client.js";

function StatusPill({ tone, label }: { tone: "ok" | "warn" | "bad"; label: string }) {
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

export function App() {
  const bridge = useAppStore((s) => s.bridge);
  const bridgeVersion = useAppStore((s) => s.bridgeVersion);
  const readOnly = useAppStore((s) => s.readOnly);
  const stadium = useAppStore((s) => s.stadium);
  const lastEvents = useAppStore((s) => s.lastEventAddresses);

  const bridgeUp = bridge === "open";
  const stadiumReady = stadium?.state === "ready";

  return (
    <div className="shell">
      <header className="statusbar">
        <h1>Stadium Deck</h1>
        <div className="status-group">
          {bridgeUp ? (
            <StatusPill tone="ok" label={`Bridge v${bridgeVersion ?? "?"}`} />
          ) : (
            <StatusPill tone="bad" label={bridge === "connecting" ? "Bridge: connecting…" : "Bridge unreachable"} />
          )}
          {bridgeUp &&
            (stadiumReady ? (
              <StatusPill tone="ok" label="Stadium online" />
            ) : (
              <StatusPill
                tone="warn"
                label={`Stadium ${stadium?.state ?? "unknown"}${stadium?.reason ? ` — ${stadium.reason}` : ""}`}
              />
            ))}
          <button
            type="button"
            className={`readonly-toggle ${readOnly ? "on" : "off"}`}
            onClick={() => setReadOnly(!readOnly)}
            disabled={!bridgeUp}
          >
            {readOnly ? "READ-ONLY" : "WRITES ENABLED"}
          </button>
        </div>
      </header>

      <main className="content">
        {!bridgeUp && (
          <section className="card">
            <h2>Bridge unreachable</h2>
            <p>
              The iPad can’t reach the bridge daemon. Make sure it is running on the Mac/Pi (
              <code>npm run bridge</code>) and that this page was opened from the bridge’s own URL.
            </p>
          </section>
        )}

        {bridgeUp && !stadiumReady && (
          <section className="card">
            <h2>Bridge up — Stadium offline</h2>
            <p>
              The bridge is running but has no link to the Stadium ({stadium?.state ?? "unknown"}
              {stadium?.reason ? `: ${stadium.reason}` : ""}). It keeps retrying automatically — check the unit is
              awake and on the same network.
            </p>
          </section>
        )}

        {bridgeUp && stadiumReady && (
          <section className="card">
            <h2>{stadium?.device?.model ?? "Helix Stadium"}</h2>
            <p>
              Firmware {stadium?.device?.firmwareVersion ?? "unknown"} · compatibility{" "}
              {stadium?.device?.compatibility ?? "unknown"} · host {stadium?.host ?? "?"}
            </p>
            {(stadium?.device?.warnings ?? []).map((warning) => (
              <p key={warning} className="warning">
                {warning}
              </p>
            ))}
            <p className="dim">
              Phase 0 shell — the live board arrives in Phase 1. Recent device events:{" "}
              {lastEvents.length > 0 ? lastEvents.join(", ") : "none yet"}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
