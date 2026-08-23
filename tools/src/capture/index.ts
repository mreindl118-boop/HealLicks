/**
 * `npm run capture` — the Guided Capture Wizard.
 *
 * Runs the whole Phase 0 capture session interactively and verifies every
 * step itself: preflight (discovery, device info, disk, permissions, editor
 * state), mode selection, the one-action-at-a-time script, and the wrap-up
 * manifest + summary.
 *
 * Flags:
 *   --mode A|B            skip the mode question
 *   --host <ip>           manual device host (skips mDNS; also for the mock)
 *   --update-port <n>     with --host (default 2001)
 *   --command-port <n>    with --host (default 2002)
 *   --iface <name>        capture interface for Mode A (default en0)
 *   --session-dir <path>  where to write the session (default ./captures/session-<stamp>)
 *   --include-optional    include the power-cycle step
 */

import { platform } from "node:os";
import { join, resolve } from "node:path";
import { ObserveBackend, TcpdumpBackend, type CaptureBackend } from "./backends.js";
import { ManifestWriter, type SessionManifest } from "./manifest.js";
import {
  checkCaptureDirectory,
  discoverLoop,
  editorCheckForMode,
  environmentSummary,
  preflightHeader,
  printCheck,
  readDeviceInfo,
  tcpdumpCheck,
  type ManualTarget,
  type PreflightTarget,
} from "./preflight.js";
import type { CaptureMode } from "./script.js";
import { CaptureWizard } from "./wizard.js";
import { InputEnded, ask, bullet, closeUi, header, pressEnter, style, yesNo } from "./ui.js";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function chooseMode(): Promise<CaptureMode> {
  const preset = flagValue("--mode")?.toUpperCase();
  if (preset === "A" || preset === "B") return preset;
  header("CHOOSE A CAPTURE MODE");
  console.log("");
  console.log(`  ${style.step("Mode A — Passive sniff")} ${style.ok("(recommended first)")}`);
  bullet("The OFFICIAL Helix Stadium editor stays OPEN on this Mac.");
  bullet("tcpdump records editor<->device traffic while you click IN THE EDITOR.");
  bullet("Captures command messages AND responses — the primary signature source.");
  console.log("");
  console.log(`  ${style.step("Mode B — Direct observe")}`);
  bullet("The official editor is CLOSED.");
  bullet("Our harness connects READ-ONLY (handshake + subscribe only, never control messages)");
  bullet("and logs device broadcasts while you touch THE PHYSICAL UNIT.");
  bullet("Note: on-device edits do not cross the editor command stream, so expect");
  bullet("fewer messages here — sync events, pushes, and heartbeats.");
  console.log("");
  for (;;) {
    const answer = (await ask(style.key("  Which mode? [A/b]"))).toUpperCase() || "A";
    if (answer === "A" || answer === "B") return answer as CaptureMode;
  }
}

async function main(): Promise<number> {
  header("STADIUM DECK — GUIDED CAPTURE WIZARD");
  console.log(style.dim("  Un-messupable by design: one action at a time, every step verified."));

  const mode = await chooseMode();

  // ---------------------------------------------------------------- preflight
  preflightHeader();

  const manualHost = flagValue("--host");
  const manual: ManualTarget | null =
    manualHost !== undefined
      ? {
          host: manualHost,
          updatePort: Number.parseInt(flagValue("--update-port") ?? "2001", 10),
          commandPort: Number.parseInt(flagValue("--command-port") ?? "2002", 10),
        }
      : null;

  console.log("");
  const target: PreflightTarget = await discoverLoop(manual);
  console.log(`  ${style.ok("✓")} Device target: ${target.host} (update ${target.updatePort}, command ${target.commandPort})`);

  // Device model + firmware into the manifest (brief read-only connection).
  let model: string | null = null;
  let firmware: string | null = null;
  let productInfoRaw: unknown = null;
  for (;;) {
    try {
      process.stdout.write("  Reading device model + firmware... ");
      const device = await readDeviceInfo(target);
      model = device.info.model;
      firmware = device.info.firmwareVersion;
      productInfoRaw = device.raw;
      console.log(style.ok(`${model ?? "unknown model"}, firmware ${firmware ?? "unknown"}`));
      break;
    } catch (error) {
      console.log(style.bad("failed"));
      console.log(`    ${style.bad(String(error instanceof Error ? error.message : error))}`);
      bullet("Is another editor hogging the connection? Is Remote Access set to Allow?");
      const retry = await yesNo("  Retry reading device info?");
      if (!retry) return 1;
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const sessionDir = resolve(flagValue("--session-dir") ?? join("captures", `session-${stamp}`));
  if (!printCheck(`Capture directory ${sessionDir} (disk space, writability)`, checkCaptureDirectory(sessionDir))) {
    return 1;
  }

  const interfaceName = flagValue("--iface") ?? (platform() === "darwin" ? "en0" : "eth0");
  if (mode === "A") {
    if (!printCheck(`tcpdump capture permission on ${interfaceName}`, tcpdumpCheck(interfaceName))) {
      console.log(style.dim("\n  Fix the above, then run npm run capture again."));
      return 1;
    }
  }

  // Editor state for the chosen mode — loop until satisfied.
  for (;;) {
    const check = editorCheckForMode(mode, target.commandPort);
    if (printCheck(mode === "A" ? "Official editor OPEN and connected" : "Official editor CLOSED", check)) break;
    const answer = await pressEnter(style.key("  Fix that, then press Enter to re-check (q quits)..."));
    if (answer === "q") return 1;
  }

  // ---------------------------------------------------------------- backend
  const manifest = new ManifestWriter(sessionDir, buildManifest(mode, target, model, firmware, productInfoRaw));

  let backend: CaptureBackend;
  if (mode === "A") {
    backend = new TcpdumpBackend({
      segmentsDir: join(sessionDir, "segments"),
      interfaceName,
      updatePort: target.updatePort,
      commandPort: target.commandPort,
      editorCheck: async () => editorCheckForMode("A", target.commandPort),
    });
  } else {
    const observer = new ObserveBackend({
      segmentsDir: join(sessionDir, "segments"),
      host: target.host,
      updatePort: target.updatePort,
      commandPort: target.commandPort,
    });
    process.stdout.write("  Opening read-only observer link (handshake + subscribe only)... ");
    try {
      await observer.connect();
      console.log(style.ok("connected"));
    } catch (error) {
      console.log(style.bad("failed"));
      console.log(`    ${style.bad(String(error instanceof Error ? error.message : error))}`);
      return 1;
    }
    backend = observer;
  }

  const includeOptional = process.argv.includes("--include-optional")
    ? true
    : await yesNo("  Include the optional power-cycle step at the end?");

  // ---------------------------------------------------------------- run
  const wizard = new CaptureWizard({
    mode,
    backend,
    manifest,
    includeOptional,
    invariantCheck: async () => {
      const link = await backend.checkInvariant();
      if (!link.ok) return link;
      return editorCheckForMode(mode, target.commandPort);
    },
  });

  let outcome: "complete" | "aborted";
  try {
    outcome = await wizard.run();
  } catch (error) {
    if (error instanceof InputEnded) {
      console.log(style.warn("\n  Input ended — closing the session cleanly."));
      manifest.addNote("Session ended because terminal input closed.");
      outcome = "aborted";
    } else {
      throw error;
    }
  } finally {
    await backend.dispose();
    manifest.finish();
  }

  header(outcome === "complete" ? "SESSION COMPLETE" : "SESSION ENDED EARLY");
  console.log("");
  console.log(`  Manifest : ${join(sessionDir, "manifest.json")}`);
  console.log(`  Summary  : ${join(sessionDir, "summary.md")}`);
  console.log(`  Segments : ${join(sessionDir, "segments")}/`);
  console.log("");
  console.log(style.step("  Next steps:"));
  bullet("Diff adjacent segments to isolate per-action message signatures.");
  if (mode === "A") {
    bullet("Decode pcaps:  npm run cli -- decode-pcap <segment.pcap>");
  }
  bullet("Update PROTOCOL.md with confirmed shapes + the firmware version above.");
  bullet("Seed mock fixtures from the captures (see PROTOCOL.md, 'Mock fidelity').");
  console.log("");
  if (outcome === "complete") console.log(style.ok("  Session complete.\n"));
  return 0;
}

function buildManifest(
  mode: CaptureMode,
  target: PreflightTarget,
  model: string | null,
  firmware: string | null,
  productInfoRaw: unknown,
): SessionManifest {
  return {
    createdAt: new Date().toISOString(),
    finishedAt: null,
    mode,
    modeLabel:
      mode === "A" ? "Passive sniff (official editor open, tcpdump)" : "Direct observe (read-only harness link)",
    device: {
      instanceName: target.instanceName,
      host: target.host,
      updatePort: target.updatePort,
      commandPort: target.commandPort,
      model,
      firmware,
      productInfoRaw,
      discoveredVia: target.discoveredVia,
    },
    environment: environmentSummary(),
    baselineIdle: { messagesPerSecond: null, heartbeatIntervalMs: null },
    segments: [],
    notes: [],
  };
}

main()
  .then((code) => {
    closeUi();
    process.exit(code);
  })
  .catch((error) => {
    closeUi();
    if (error instanceof InputEnded) {
      console.log(style.warn("\nTerminal input ended — wizard closed. Nothing was captured incorrectly; re-run npm run capture to start again."));
      process.exit(1);
    }
    console.error(style.bad(`\nWizard crashed: ${error instanceof Error ? (error.stack ?? error.message) : error}`));
    process.exit(1);
  });
