/**
 * The one-action-at-a-time loop:
 *   1. ONE plain-language instruction
 *   2. fresh auto-labeled capture segment
 *   3. auto-verification ("✓ Captured (N messages)" / "✗ Nothing detected")
 *      with unlimited retries
 *   4. y/n confirmation — 'n' marks the segment discarded (never deleted)
 *      and repeats the step
 *   5. enforced quiet settle gap between steps so segments diff cleanly,
 *      with unexpected-traffic detection offering a redo
 * Plus pause and redo-last-step at any boundary, and continuous re-checks of
 * the mode invariant (editor open/closed, observer link up).
 */

import type { CaptureBackend, SegmentStats } from "./backends.js";
import { ObserveBackend } from "./backends.js";
import { ManifestWriter, type SegmentRecord } from "./manifest.js";
import { CAPTURE_SCRIPT, SETTLE_GAP_MS, type CaptureMode, type CaptureStep } from "./script.js";
import { ask, bullet, countdown, header, pressEnter, sleep, style, yesNo } from "./ui.js";

export interface WizardOptions {
  mode: CaptureMode;
  backend: CaptureBackend;
  manifest: ManifestWriter;
  includeOptional: boolean;
  /** Re-check the mode invariant (editor open/closed etc). */
  invariantCheck: () => Promise<{ ok: boolean; problem?: string; fix?: string[] }>;
}

type StepOutcome = "captured" | "skipped" | "quit" | "redoPrevious";

export class CaptureWizard {
  private segmentIndex = 0;
  private idleRatePerSecond: number | null = null;

  constructor(private readonly options: WizardOptions) {}

  async run(): Promise<"complete" | "aborted"> {
    const steps = CAPTURE_SCRIPT.filter((step) => this.instructionFor(step) !== null).filter(
      (step) => this.options.includeOptional || !step.optional,
    );
    console.log("");
    console.log(style.dim(`  ${steps.length} steps in this session. Commands at any prompt: `));
    console.log(
      style.dim(`  ${style.key("Enter")}=go  ${style.key("r")}=redo last  ${style.key("p")}=pause  ${style.key("s")}=skip step  ${style.key("q")}=quit (writes manifest)`),
    );

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const outcome = await this.runStepWithRetries(step, i + 1, steps.length);
      if (outcome === "quit") {
        this.options.manifest.addNote("Session ended early by user.");
        return "aborted";
      }
      if (outcome === "redoPrevious") {
        if (i === 0) {
          console.log(style.warn("  This is the first step — nothing to redo."));
        } else {
          this.options.manifest.addNote(`User chose to redo step ${steps[i - 1]!.id} from the following step's prompt.`);
        }
        i = Math.max(-1, i - 2); // loop's i++ lands on the previous step (or repeats step 0)
        continue;
      }
      if (i < steps.length - 1) {
        const command = await this.settleGap();
        if (command === "redo") {
          i -= 1; // repeat the step we just finished (as a fresh attempt set)
          this.options.manifest.addNote(`User chose to redo step ${step.id} after its settle gap.`);
        } else if (command === "quit") {
          this.options.manifest.addNote("Session ended early by user.");
          return "aborted";
        }
      }
    }
    return "complete";
  }

  private instructionFor(step: CaptureStep): string | null {
    return this.options.mode === "A" ? step.instructionA : step.instructionB;
  }

  private async ensureInvariant(): Promise<boolean> {
    for (;;) {
      const check = await this.options.invariantCheck();
      if (check.ok) return true;
      console.log("");
      console.log(`  ${style.bad("⏸ PAUSED —")} ${check.problem ?? "session invariant broken"}`);
      for (const fix of check.fix ?? []) bullet(style.warn(fix));
      const answer = await pressEnter(style.key("  Fix the above, then press Enter to re-check (q to quit)..."));
      if (answer === "q") return false;
      if (this.options.backend instanceof ObserveBackend) {
        await this.options.backend.reconnectIfDown();
      }
    }
  }

  private async runStepWithRetries(step: CaptureStep, number: number, total: number): Promise<StepOutcome> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (!(await this.ensureInvariant())) return "quit";

      header(`STEP ${number}/${total} — ${step.title}${attempt > 1 ? `  (attempt ${attempt})` : ""}`);
      console.log("");
      console.log(`  ${style.step(this.instructionFor(step)!)}`);
      for (const note of step.notes ?? []) console.log(`  ${style.dim(note)}`);
      console.log("");

      const preCommand = await pressEnter(
        step.durationMs !== undefined
          ? style.key(`  Press Enter to start the ${Math.round(step.durationMs / 1000)}s hands-off window...`)
          : style.key("  Press Enter when you are READY to do this (capture starts first)..."),
      );
      if (preCommand === "q") return "quit";
      if (preCommand === "r") return "redoPrevious";
      if (preCommand === "s") {
        this.recordSegment(step, attempt, null, "skipped", null);
        console.log(style.warn("  Step skipped."));
        return "skipped";
      }
      if (preCommand === "p") {
        await pressEnter(style.key("  Paused. Press Enter to resume..."));
        attempt -= 1;
        continue;
      }

      const fileBase = `${String(this.segmentIndex + 1).padStart(2, "0")}-${step.id}${attempt > 1 ? `-attempt${attempt}` : ""}`;
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      try {
        await this.options.backend.startSegment(fileBase);
      } catch (error) {
        console.log(style.bad(`  Could not open the capture segment: ${error instanceof Error ? error.message : error}`));
        const retry = await yesNo("  Try this step again?");
        if (!retry) return "quit";
        attempt -= 1;
        continue;
      }

      if (step.durationMs !== undefined) {
        await countdown("Hands off!", step.durationMs);
      } else {
        console.log(style.ok("  ● Recording. Do the action now."));
        const during = await pressEnter(style.key("  Press Enter the MOMENT you are done..."));
        if (during === "q") {
          await this.options.backend.endSegment();
          return "quit";
        }
      }
      // Small tail so trailing acks/pushes land in the segment.
      await sleep(750);
      const stats = await this.options.backend.endSegment();
      const durationMs = Date.now() - startedMs;

      const verified = this.verify(step, stats, durationMs);
      if (!verified) {
        console.log(style.bad(`  ✗ Nothing detected (${stats.messageCount} ${this.options.backend.unit} — all idle noise).`));
        this.recordSegment(step, attempt, startedAt, "failed", stats);
        console.log(style.dim("  The action may not have generated traffic, or it happened before/after the segment."));
        const retry = await yesNo("  Try the same step again?");
        if (retry) continue;
        // The "failed" record above already covers this attempt's file;
        // moving on without a duplicate entry keeps index<->file mapping 1:1.
        return "skipped";
      }

      const shownCount = step.id === "01-baseline" ? stats.messageCount : stats.actionMessageCount;
      console.log(style.ok(`  ✓ Captured (${shownCount} ${this.options.backend.unit}${this.topAddresses(stats)})`));
      if (step.id === "01-baseline") {
        this.recordBaseline(stats, durationMs);
      }

      const matched = await yesNo("  Did what you did match the instruction exactly?");
      if (!matched) {
        this.recordSegment(step, attempt, startedAt, "discarded", stats);
        console.log(style.warn("  Segment marked discarded (file kept). Let's redo it."));
        continue;
      }
      const note = await ask(style.dim("  Optional note for this segment (model/preset names etc), or Enter:"));
      this.recordSegment(step, attempt, startedAt, "captured", stats, note || null);
      return "captured";
    }
  }

  private topAddresses(stats: SegmentStats): string {
    const top = Object.entries(stats.countsByAddress)
      .filter(([address]) => address !== "/heartbeat" && address !== "packets")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([address, count]) => `${address}×${count}`);
    return top.length > 0 ? `: ${top.join(", ")}` : "";
  }

  /**
   * A segment verifies when it contains more than idle noise. Mode B counts
   * non-heartbeat messages exactly; Mode A compares packet counts against the
   * measured idle rate (heartbeats keep flowing during every segment).
   */
  private verify(step: CaptureStep, stats: SegmentStats, durationMs: number): boolean {
    if (step.id === "01-baseline") {
      return stats.messageCount > 0; // idle traffic itself is the point
    }
    if (this.options.backend.unit === "messages") {
      return stats.actionMessageCount > 0;
    }
    const idleExpected =
      this.idleRatePerSecond !== null ? (durationMs / 1000) * this.idleRatePerSecond : 0;
    return stats.messageCount > Math.ceil(idleExpected * 1.5) + 1;
  }

  private recordBaseline(stats: SegmentStats, durationMs: number): void {
    const seconds = durationMs / 1000;
    this.idleRatePerSecond = stats.messageCount / Math.max(seconds, 1);
    this.options.manifest.manifest.baselineIdle.messagesPerSecond = this.idleRatePerSecond;
    const heartbeats = stats.countsByAddress["/heartbeat"];
    if (heartbeats !== undefined && heartbeats > 1) {
      this.options.manifest.manifest.baselineIdle.heartbeatIntervalMs = (durationMs / heartbeats);
    }
    this.options.manifest.flush();
    console.log(
      style.dim(
        `  Idle baseline recorded: ${this.idleRatePerSecond.toFixed(2)} ${this.options.backend.unit}/s${
          heartbeats ? `, heartbeat ~${Math.round(durationMs / heartbeats)}ms` : ""
        }`,
      ),
    );
  }

  private recordSegment(
    step: CaptureStep,
    attempt: number,
    startedAt: string | null,
    status: SegmentRecord["status"],
    stats: SegmentStats | null,
    userNote: string | null = null,
  ): void {
    this.segmentIndex += 1;
    this.options.manifest.upsertSegment({
      index: this.segmentIndex,
      stepId: step.id,
      title: step.title,
      file: stats?.file ?? null,
      status,
      attempts: attempt,
      messageCount: stats?.messageCount ?? 0,
      countsByAddress: stats?.countsByAddress ?? {},
      startedAt: startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      userNote,
    });
  }

  /**
   * Enforced quiet gap between steps. In Mode B we watch live counts and flag
   * unexpected traffic (something got touched); the user can redo the step.
   */
  private async settleGap(): Promise<"ok" | "redo" | "quit"> {
    const before = this.options.backend.liveCount();
    console.log("");
    await countdown(style.dim("Settle gap — touch nothing."), SETTLE_GAP_MS);
    const observed = this.options.backend.liveCount() - before;
    if (observed > 0) {
      console.log(
        style.warn(`  ⚠ Unexpected traffic during the settle gap (${observed} non-heartbeat messages).`),
      );
      console.log(style.dim("  If you touched something, redo the last step so its segment stays clean."));
      const redo = await yesNo("  Redo the last step?");
      if (redo) return "redo";
      this.options.manifest.addNote(
        `Unexpected traffic (${observed} messages) during settle gap after segment ${this.segmentIndex}; user chose to continue.`,
      );
    }
    const command = await pressEnter(
      style.key(`  ${style.dim("Next:")} Enter=continue  r=redo last  q=quit `),
    );
    if (command === "r") return "redo";
    if (command === "q") return "quit";
    return "ok";
  }
}
