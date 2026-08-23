/**
 * App state (zustand). Phase 0 mirrors only connection/link state; the full
 * device-state mirror (presets, chain, params) lands in Phase 1 and will be
 * built from bridge deviceEvent messages with optimistic updates + rollback.
 */

import { create } from "zustand";
import type { StadiumStatusPayload } from "@stadium-deck/protocol";

export type BridgeConnectionState = "connecting" | "open" | "closed";

export interface AppState {
  bridge: BridgeConnectionState;
  bridgeVersion: string | null;
  readOnly: boolean;
  stadium: StadiumStatusPayload | null;
  lastEventAddresses: string[];
  setBridge(state: BridgeConnectionState): void;
  setHello(version: string, readOnly: boolean, stadium: StadiumStatusPayload): void;
  setStadium(stadium: StadiumStatusPayload): void;
  setReadOnly(readOnly: boolean): void;
  noteEvent(address: string): void;
}

export const useAppStore = create<AppState>((set) => ({
  bridge: "connecting",
  bridgeVersion: null,
  readOnly: true,
  stadium: null,
  lastEventAddresses: [],
  setBridge: (bridge) => set({ bridge }),
  setHello: (bridgeVersion, readOnly, stadium) => set({ bridge: "open", bridgeVersion, readOnly, stadium }),
  setStadium: (stadium) => set({ stadium }),
  setReadOnly: (readOnly) => set({ readOnly }),
  noteEvent: (address) =>
    set((state) => ({
      lastEventAddresses: [address, ...state.lastEventAddresses].slice(0, 8),
    })),
}));
