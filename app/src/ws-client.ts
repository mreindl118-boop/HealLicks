/**
 * Same-origin WebSocket client with the Safari survival kit:
 * iPadOS kills WebSockets when the tab sleeps or the PWA is backgrounded, so
 * this client silently reconnects with backoff and performs a full resync on
 * visibilitychange/pageshow — preserving UI context (the store is only
 * updated, never reset, on reconnect).
 */

import { WS_PROTOCOL_VERSION, type AppToBridge, type BridgeToApp, type JsonOscValue } from "@stadium-deck/protocol";
import { useAppStore } from "./store.js";

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: number | null = null;
let requestCounter = 0;

type PendingResolver = (message: Extract<BridgeToApp, { type: "response" }>) => void;
const pending = new Map<string, PendingResolver>();

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function connect(): void {
  if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  useAppStore.getState().setBridge("connecting");
  socket = new WebSocket(wsUrl());

  socket.onopen = () => {
    reconnectAttempt = 0;
  };

  socket.onmessage = (event: MessageEvent<string>) => {
    let message: BridgeToApp;
    try {
      message = JSON.parse(event.data) as BridgeToApp;
    } catch {
      return;
    }
    handleMessage(message);
  };

  socket.onclose = () => {
    useAppStore.getState().setBridge("closed");
    for (const [, resolve] of pending) {
      resolve({ type: "response", requestId: "", ok: false, reply: null, failure: "aborted", detail: "bridge connection lost" });
    }
    pending.clear();
    scheduleReconnect();
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectAttempt += 1;
  const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleMessage(message: BridgeToApp): void {
  const store = useAppStore.getState();
  switch (message.type) {
    case "hello":
      if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
        console.warn(`bridge ws protocol ${message.protocolVersion}, app expects ${WS_PROTOCOL_VERSION}`);
      }
      store.setHello(message.bridgeVersion, message.readOnly, message.stadium);
      break;
    case "stadiumStatus":
      store.setStadium(message.stadium);
      break;
    case "readOnlyChanged":
      store.setReadOnly(message.readOnly);
      break;
    case "deviceEvent":
      store.noteEvent(message.message.address);
      break;
    case "response": {
      const resolver = pending.get(message.requestId);
      if (resolver) {
        pending.delete(message.requestId);
        resolver(message);
      }
      break;
    }
    case "pong":
    case "bridgeError":
      break;
  }
}

export function send(message: AppToBridge): boolean {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/**
 * Send a correlated request; resolves with the bridge's response envelope.
 * `args` exclude the cmdId (the bridge allocates it); typeTags keep its `i`.
 */
export function request(
  address: string,
  typeTags: string,
  args: JsonOscValue[],
  expectAddress?: string,
): Promise<Extract<BridgeToApp, { type: "response" }>> {
  return new Promise((resolve) => {
    const requestId = `r${++requestCounter}`;
    pending.set(requestId, resolve);
    const payload: AppToBridge =
      expectAddress !== undefined
        ? { type: "request", requestId, address, typeTags, args, expectAddress }
        : { type: "request", requestId, address, typeTags, args };
    if (!send(payload)) {
      pending.delete(requestId);
      resolve({ type: "response", requestId, ok: false, reply: null, failure: "aborted", detail: "bridge unreachable" });
    }
  });
}

export function setReadOnly(readOnly: boolean): void {
  send({ type: "setReadOnly", readOnly });
}

/** Full state resync — called on reconnect-relevant lifecycle events. */
export function resync(): void {
  if (!send({ type: "resync" })) connect();
}

export function installLifecycleHandlers(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resync();
  });
  // pageshow fires on bfcache restores where visibilitychange may not.
  window.addEventListener("pageshow", () => resync());
  window.addEventListener("online", () => resync());
}
