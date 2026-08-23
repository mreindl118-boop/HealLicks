/**
 * Connection state machine for a Stadium link.
 *
 * Pure transition function + reconnect backoff policy; the bridge drives it
 * with real sockets and timers, tests drive it synthetically. States cover
 * the full lifecycle from discovery to steady-state, plus reconnection with
 * exponential backoff.
 */

export type ConnectionState =
  | "idle"
  | "discovering"
  | "connecting"
  | "handshaking"
  | "ready"
  | "reconnectWait"
  | "closed";

export type ConnectionEvent =
  | { type: "start" }
  | { type: "serviceFound"; host: string; updatePort: number; commandPort: number }
  | { type: "socketsConnected" }
  | { type: "handshakeComplete" }
  | { type: "heartbeatTimeout" }
  | { type: "socketError"; error: string }
  | { type: "socketClosed" }
  | { type: "backoffElapsed" }
  | { type: "close" };

export type ConnectionAction =
  | { type: "startDiscovery" }
  | { type: "openSockets"; host: string; updatePort: number; commandPort: number }
  | { type: "performHandshake" }
  | { type: "beginSteadyState" }
  | { type: "teardownSockets" }
  | { type: "scheduleReconnect"; delayMs: number; attempt: number }
  | { type: "notifyOffline"; reason: string }
  | { type: "notifyOnline" };

export interface MachineContext {
  attempt: number;
  target: { host: string; updatePort: number; commandPort: number } | null;
}

export interface TransitionResult {
  state: ConnectionState;
  context: MachineContext;
  actions: ConnectionAction[];
}

export interface BackoffPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  /** 0..1 fraction of random jitter applied on top of the base delay. */
  jitterFraction: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterFraction: 0.2,
};

/** `random` is injectable for deterministic tests (defaults to Math.random). */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, attempt - 1)),
  );
  const jitter = base * policy.jitterFraction * random();
  return Math.round(base + jitter);
}

export function initialContext(): MachineContext {
  return { attempt: 0, target: null };
}

export function transition(
  state: ConnectionState,
  context: MachineContext,
  event: ConnectionEvent,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): TransitionResult {
  const same = (actions: ConnectionAction[] = []): TransitionResult => ({ state, context, actions });

  const toReconnect = (reason: string): TransitionResult => {
    const attempt = context.attempt + 1;
    const delayMs = backoffDelay(attempt, policy, random);
    return {
      state: "reconnectWait",
      context: { ...context, attempt },
      actions: [
        { type: "teardownSockets" },
        { type: "notifyOffline", reason },
        { type: "scheduleReconnect", delayMs, attempt },
      ],
    };
  };

  if (event.type === "close") {
    return {
      state: "closed",
      context,
      actions: state === "closed" ? [] : [{ type: "teardownSockets" }],
    };
  }

  switch (state) {
    case "idle": {
      if (event.type === "start") {
        return {
          state: "discovering",
          context: { ...context, attempt: 0 },
          actions: [{ type: "startDiscovery" }],
        };
      }
      return same();
    }
    case "discovering": {
      if (event.type === "serviceFound") {
        const target = { host: event.host, updatePort: event.updatePort, commandPort: event.commandPort };
        return {
          state: "connecting",
          context: { ...context, target },
          actions: [{ type: "openSockets", ...target }],
        };
      }
      if (event.type === "socketError") {
        return toReconnect(event.error);
      }
      return same();
    }
    case "connecting": {
      if (event.type === "socketsConnected") {
        return { state: "handshaking", context, actions: [{ type: "performHandshake" }] };
      }
      if (event.type === "socketError" || event.type === "socketClosed") {
        return toReconnect(event.type === "socketError" ? event.error : "socket closed while connecting");
      }
      return same();
    }
    case "handshaking": {
      if (event.type === "handshakeComplete") {
        return {
          state: "ready",
          context: { ...context, attempt: 0 },
          actions: [{ type: "beginSteadyState" }, { type: "notifyOnline" }],
        };
      }
      if (event.type === "socketError" || event.type === "socketClosed") {
        return toReconnect(event.type === "socketError" ? event.error : "socket closed during handshake");
      }
      return same();
    }
    case "ready": {
      if (event.type === "heartbeatTimeout") {
        return toReconnect("heartbeat timeout");
      }
      if (event.type === "socketError" || event.type === "socketClosed") {
        return toReconnect(event.type === "socketError" ? event.error : "socket closed");
      }
      return same();
    }
    case "reconnectWait": {
      if (event.type === "backoffElapsed") {
        // Re-discover on every reconnect: the device's IP/ports may have changed.
        return { state: "discovering", context: { ...context, target: null }, actions: [{ type: "startDiscovery" }] };
      }
      return same();
    }
    case "closed": {
      if (event.type === "start") {
        return {
          state: "discovering",
          context: initialContext(),
          actions: [{ type: "startDiscovery" }],
        };
      }
      return same();
    }
  }
}
