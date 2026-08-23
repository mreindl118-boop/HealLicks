/**
 * In-memory mock device state: product info, snapshots, presets/setlists,
 * and a simplified edit buffer following the observed shapes
 * (sfg_.flow[].blks as alternating [pos, block] pairs; Row A positions 0-13,
 * Row B 14-27; content refs with cid_/name/posi/type fields).
 *
 * Values are synthesized, not captured. After the first real capture session,
 * regenerate the fixtures from live data (see PROTOCOL.md "Mock fidelity").
 */

export interface MockSnapshot {
  name: string;
  color: number;
}

export interface MockPreset {
  cid: number;
  name: string;
  position: number;
  /** 1 = setlist ref, 2 = raw preset (observed values). */
  type: 1 | 2;
  containerCid: number;
}

export interface MockBlockState {
  /** Visible flow position (Row A: 1-12, Row B: 15-26). */
  position: number;
  modelId: number;
  modelName: string;
  enabled: boolean;
  params: Map<number, number>;
}

export interface DeviceModelOptions {
  model?: string;
  firmware?: string;
}

export class DeviceModel {
  readonly model: string;
  readonly firmware: string;
  readonly sessionId = 101;

  snapshots: MockSnapshot[] = [
    { name: "SNAP 1", color: 1 },
    { name: "SNAP 2", color: 2 },
    { name: "SNAP 3", color: 3 },
    { name: "SNAP 4", color: 4 },
    { name: "SNAP 5", color: 5 },
    { name: "SNAP 6", color: 6 },
    { name: "SNAP 7", color: 7 },
    { name: "SNAP 8", color: 8 },
  ];
  activeSnapshotIndex = 0;

  presets: MockPreset[] = [];
  activePresetCid: number;
  presetEdited = false;

  blocks: MockBlockState[] = [
    { position: 1, modelId: 1001, modelName: "Mock Drive", enabled: true, params: new Map([[0, 0.5], [1, 0.4]]) },
    { position: 2, modelId: 2001, modelName: "Mock Amp", enabled: true, params: new Map([[0, 0.6], [1, 0.5], [2, 0.5]]) },
    { position: 3, modelId: 3001, modelName: "Mock Cab", enabled: true, params: new Map([[0, 0.5]]) },
    { position: 4, modelId: 4001, modelName: "Mock Delay", enabled: false, params: new Map([[0, 0.35], [1, 0.4]]) },
  ];

  properties = new Map<string, string | number>([
    ["global.modelselect.addcabblock", 1],
    ["preset.meta.info", "Synthesized mock preset."],
  ]);

  constructor(options: DeviceModelOptions = {}) {
    this.model = options.model ?? "Helix Stadium XL (Mock)";
    this.firmware = options.firmware ?? "0.0.0-mock";

    let cid = 1000;
    const factory = ["Factory Clean", "Factory Crunch", "Factory Lead"];
    const user = ["Couch Riff", "Big Verse", "Solo Boost", "Ambient Pad"];
    factory.forEach((name, i) => this.presets.push({ cid: ++cid, name, position: i, type: 2, containerCid: -1 }));
    user.forEach((name, i) => this.presets.push({ cid: ++cid, name, position: i, type: 2, containerCid: -2 }));
    this.activePresetCid = this.presets.find((p) => p.containerCid === -2)!.cid;
  }

  presetByCid(cid: number): MockPreset | undefined {
    return this.presets.find((p) => p.cid === cid);
  }

  presetAt(containerCid: number, position: number): MockPreset | undefined {
    return this.presets.find((p) => p.containerCid === containerCid && p.position === position);
  }

  containerContents(containerCid: number): MockPreset[] {
    return this.presets
      .filter((p) => p.containerCid === containerCid)
      .sort((a, b) => a.position - b.position);
  }

  blockAt(position: number): MockBlockState | undefined {
    return this.blocks.find((b) => b.position === position);
  }

  /** Product info payload for /getProductInfo (shape synthesized). */
  productInfo(): Record<string, unknown> {
    return {
      model: this.model,
      firmware: this.firmware,
      serial: "MOCK-000001",
      mock: true,
    };
  }

  /** Content ref fields per docs: cid_, ccid, cctp, name, posi, type (+ rcid for setlist refs). */
  contentRef(preset: MockPreset): Record<string, unknown> {
    return {
      cid_: preset.cid,
      ccid: preset.containerCid,
      cctp: 0,
      name: preset.name,
      posi: preset.position,
      type: preset.type,
    };
  }

  /**
   * Simplified edit buffer in the observed sfg_ shape: one flow with blks as
   * alternating [pos, block] pairs (0 = input, 13 = output) and a bmap.
   */
  editBufferState(): Record<string, unknown> {
    const pairs: (number | Record<string, unknown>)[] = [0, { id__: 0, kind: "input" }];
    for (const block of this.blocks) {
      pairs.push(block.position, {
        id__: block.position,
        mid_: block.modelId,
        name: block.modelName,
        enab: block.enabled ? 1 : 0,
      });
    }
    pairs.push(13, { id__: 13, kind: "output" });
    const bmap = Array.from({ length: 28 }, (_, i) => i);
    return {
      sfg_: { flow: [{ blks: pairs, bmap }] },
      snap: { count: this.snapshots.length, active: this.activeSnapshotIndex },
      edtd: this.presetEdited ? 1 : 0,
    };
  }
}
