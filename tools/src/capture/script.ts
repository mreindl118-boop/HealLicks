/**
 * The Phase 0 capture script: atomic actions in a fixed order. Each step has
 * per-mode instructions — Mode A tells you what to click IN THE EDITOR,
 * Mode B what to touch ON THE PHYSICAL UNIT. Steps a mode can't observe are
 * skipped for that mode.
 *
 * Capture gotcha baked in (from the community repo): edits made on the device
 * itself do NOT traverse the editor<->device command stream, so Mode B mostly
 * sees broadcast/sync events; Mode A (official editor open) is the primary
 * source for command-message signatures. That is why Mode A is recommended
 * first.
 */

export type CaptureMode = "A" | "B";

export interface CaptureStep {
  id: string;
  title: string;
  /** null = step not applicable in that mode. */
  instructionA: string | null;
  instructionB: string | null;
  /** Timed hands-off step (ms); otherwise the user confirms with Enter. */
  durationMs?: number;
  /** Extra guidance shown under the instruction. */
  notes?: string[];
  optional?: boolean;
}

export const SETTLE_GAP_MS = 4000;

export const CAPTURE_SCRIPT: CaptureStep[] = [
  {
    id: "01-baseline",
    title: "Baseline (idle/heartbeat traffic)",
    instructionA: "Touch NOTHING for 60 seconds — not the editor, not the Stadium.",
    instructionB: "Touch NOTHING for 60 seconds — leave the Stadium completely alone.",
    // CAPTURE_BASELINE_MS overrides for automated wizard testing only.
    durationMs: Number.parseInt(process.env["CAPTURE_BASELINE_MS"] ?? "60000", 10),
    notes: ["This measures idle heartbeat cadence and gives every later diff a clean floor."],
  },
  {
    id: "02-preset-next",
    title: "Preset: next",
    instructionA: "In the editor, switch to the NEXT preset (one step down the preset list). Touch nothing else.",
    instructionB: "On the Stadium, press the preset UP/next footswitch or knob ONCE. Touch nothing else.",
  },
  {
    id: "03-preset-prev",
    title: "Preset: previous",
    instructionA: "In the editor, switch back to the PREVIOUS preset. Touch nothing else.",
    instructionB: "On the Stadium, go back to the PREVIOUS preset. Touch nothing else.",
  },
  {
    id: "04-preset-named",
    title: "Preset: jump to a named preset",
    instructionA: "In the editor, click directly on a specific preset a few slots away (note its name when asked). Touch nothing else.",
    instructionB: "On the Stadium, jump directly to a specific preset a few slots away. Touch nothing else.",
  },
  {
    id: "05-snapshot-1-2",
    title: "Snapshot 1 -> 2",
    instructionA: "In the editor, switch from snapshot 1 to snapshot 2. Touch nothing else.",
    instructionB: "On the Stadium, switch from snapshot 1 to snapshot 2. Touch nothing else.",
  },
  {
    id: "06-snapshot-2-3",
    title: "Snapshot 2 -> 3",
    instructionA: "In the editor, switch from snapshot 2 to snapshot 3. Touch nothing else.",
    instructionB: "On the Stadium, switch from snapshot 2 to snapshot 3. Touch nothing else.",
  },
  {
    id: "07-snapshot-back-1",
    title: "Snapshot back to 1",
    instructionA: "In the editor, switch back to snapshot 1. Touch nothing else.",
    instructionB: "On the Stadium, switch back to snapshot 1. Touch nothing else.",
  },
  {
    id: "08-footswitch-on",
    title: "Footswitch ON",
    instructionA: "In the editor, click ONE stomp footswitch to turn it ON (pick one and remember it). Touch nothing else.",
    instructionB: "On the Stadium, press ONE stomp footswitch to turn it ON (remember which). Touch nothing else.",
  },
  {
    id: "09-footswitch-off",
    title: "Same footswitch OFF",
    instructionA: "In the editor, click the SAME footswitch to turn it OFF. Touch nothing else.",
    instructionB: "On the Stadium, press the SAME footswitch to turn it OFF. Touch nothing else.",
  },
  {
    id: "10-footswitch-other",
    title: "A different footswitch",
    instructionA: "In the editor, click a DIFFERENT footswitch once. Touch nothing else.",
    instructionB: "On the Stadium, press a DIFFERENT footswitch once. Touch nothing else.",
  },
  {
    id: "11-knob-small",
    title: "One knob, small turn",
    instructionA: "In the editor, give ONE parameter knob a SMALL turn (a few percent). Touch nothing else.",
    instructionB: "On the Stadium, give ONE parameter knob a SMALL turn. Touch nothing else.",
  },
  {
    id: "12-knob-sweep",
    title: "Same knob, full sweep",
    instructionA: "In the editor, sweep the SAME knob smoothly from minimum to maximum over ~3 seconds (streaming behaviour). Touch nothing else.",
    instructionB: "On the Stadium, sweep the SAME knob min to max over ~3 seconds. Touch nothing else.",
  },
  {
    id: "13-bypass-block",
    title: "Bypass one block",
    instructionA: "In the editor, BYPASS one block in the signal chain (note which). Touch nothing else.",
    instructionB: "On the Stadium, bypass one block from the front panel. Touch nothing else.",
  },
  {
    id: "14-unbypass-block",
    title: "Un-bypass the same block",
    instructionA: "In the editor, RE-ENABLE the same block. Touch nothing else.",
    instructionB: "On the Stadium, re-enable the same block. Touch nothing else.",
  },
  {
    id: "15-model-swap",
    title: "Swap a block's model",
    instructionA: "In the editor, change ONE block's model to a specific other model (note both names when asked). Touch nothing else.",
    instructionB: null, // model browsing on-device does not traverse the editor stream usefully
    notes: ["Reveals /ModelSet and the model-id mapping."],
  },
  {
    id: "16-model-swap-back",
    title: "Swap the model back",
    instructionA: "In the editor, change that block back to its original model. Touch nothing else.",
    instructionB: null,
  },
  {
    id: "17-save-preset",
    title: "Save the preset",
    instructionA: "In the editor, SAVE the current preset (no rename yet). Touch nothing else.",
    instructionB: "On the Stadium, save the current preset. Touch nothing else.",
  },
  {
    id: "18-rename-preset",
    title: "Rename the preset",
    instructionA: "In the editor, RENAME the preset to exactly: CAPTURE-TEST (reveals string encoding). Touch nothing else.",
    instructionB: null,
  },
  {
    id: "19-rename-back",
    title: "Rename back",
    instructionA: "In the editor, rename the preset back to its original name. Touch nothing else.",
    instructionB: null,
  },
  {
    id: "20-switch-setlist",
    title: "Switch setlists",
    instructionA: "In the editor, switch to a different setlist. Touch nothing else.",
    instructionB: "On the Stadium, switch to a different setlist. Touch nothing else.",
  },
  {
    id: "21-expression-sweep",
    title: "Expression pedal slow sweep",
    instructionA: null, // pedal is physical; editor cannot generate this
    instructionB: "Slowly sweep the expression pedal heel -> toe -> heel over ~8 seconds (continuous stream + throttling behaviour).",
  },
  {
    id: "22-power-cycle",
    title: "OPTIONAL: power-cycle + reconnect",
    instructionA: "Power the Stadium OFF, wait 5 seconds, power it back ON, and wait for the editor to reconnect.",
    instructionB: "Power the Stadium OFF, wait 5 seconds, power it back ON. (The wizard's own link will drop and re-observe.)",
    optional: true,
    notes: ["Captures the reconnect/handshake sequence. The wizard expects the link to drop — that is the point."],
  },
];
