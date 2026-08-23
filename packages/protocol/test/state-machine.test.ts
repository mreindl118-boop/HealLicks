import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  DEFAULT_BACKOFF,
  initialContext,
  transition,
  type ConnectionEvent,
  type ConnectionState,
  type MachineContext,
} from "../src/state-machine.js";

const noJitter = () => 0;

function run(
  startState: ConnectionState,
  startContext: MachineContext,
  events: ConnectionEvent[],
): { state: ConnectionState; context: MachineContext; actionTypes: string[] } {
  let state = startState;
  let context = startContext;
  const actionTypes: string[] = [];
  for (const event of events) {
    const result = transition(state, context, event, DEFAULT_BACKOFF, noJitter);
    state = result.state;
    context = result.context;
    actionTypes.push(...result.actions.map((a) => a.type));
  }
  return { state, context, actionTypes };
}

describe("happy path", () => {
  it("walks idle -> discovering -> connecting -> handshaking -> ready", () => {
    const { state, actionTypes } = run("idle", initialContext(), [
      { type: "start" },
      { type: "serviceFound", host: "p35x1.local", updatePort: 2001, commandPort: 2002 },
      { type: "socketsConnected" },
      { type: "handshakeComplete" },
    ]);
    expect(state).toBe("ready");
    expect(actionTypes).toEqual([
      "startDiscovery",
      "openSockets",
      "performHandshake",
      "beginSteadyState",
      "notifyOnline",
    ]);
  });

  it("resets the attempt counter once ready", () => {
    const { context } = run("reconnectWait", { attempt: 4, target: null }, [
      { type: "backoffElapsed" },
      { type: "serviceFound", host: "h", updatePort: 2001, commandPort: 2002 },
      { type: "socketsConnected" },
      { type: "handshakeComplete" },
    ]);
    expect(context.attempt).toBe(0);
  });
});

describe("failure and reconnect", () => {
  it("heartbeat timeout tears down and schedules a reconnect", () => {
    const result = transition("ready", initialContext(), { type: "heartbeatTimeout" }, DEFAULT_BACKOFF, noJitter);
    expect(result.state).toBe("reconnectWait");
    expect(result.actions.map((a) => a.type)).toEqual(["teardownSockets", "notifyOffline", "scheduleReconnect"]);
    const schedule = result.actions.find((a) => a.type === "scheduleReconnect");
    expect(schedule).toMatchObject({ attempt: 1, delayMs: DEFAULT_BACKOFF.initialDelayMs });
  });

  it("re-discovers after backoff (device IP may have changed)", () => {
    const result = transition("reconnectWait", { attempt: 2, target: null }, { type: "backoffElapsed" });
    expect(result.state).toBe("discovering");
    expect(result.actions.map((a) => a.type)).toEqual(["startDiscovery"]);
  });

  it("escalates backoff exponentially and caps it", () => {
    expect(backoffDelay(1, DEFAULT_BACKOFF, noJitter)).toBe(1000);
    expect(backoffDelay(2, DEFAULT_BACKOFF, noJitter)).toBe(2000);
    expect(backoffDelay(3, DEFAULT_BACKOFF, noJitter)).toBe(4000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, noJitter)).toBe(DEFAULT_BACKOFF.maxDelayMs);
  });

  it("applies jitter within the configured fraction", () => {
    const jittered = backoffDelay(1, DEFAULT_BACKOFF, () => 1);
    expect(jittered).toBe(1000 + 1000 * DEFAULT_BACKOFF.jitterFraction);
  });

  it("socket errors during connecting/handshaking both lead to reconnectWait", () => {
    for (const state of ["connecting", "handshaking"] as const) {
      const result = transition(state, initialContext(), { type: "socketError", error: "ECONNRESET" });
      expect(result.state).toBe("reconnectWait");
    }
  });

  it("counts consecutive attempts across failures", () => {
    const first = transition("ready", initialContext(), { type: "socketClosed" }, DEFAULT_BACKOFF, noJitter);
    const second = run("reconnectWait", first.context, [
      { type: "backoffElapsed" },
      { type: "serviceFound", host: "h", updatePort: 2001, commandPort: 2002 },
      { type: "socketClosed" },
    ]);
    expect(second.context.attempt).toBe(2);
  });
});

describe("close", () => {
  it("close from any state tears down and lands in closed", () => {
    for (const state of ["discovering", "connecting", "handshaking", "ready", "reconnectWait"] as const) {
      const result = transition(state, initialContext(), { type: "close" });
      expect(result.state).toBe("closed");
      expect(result.actions.map((a) => a.type)).toEqual(["teardownSockets"]);
    }
  });

  it("closed can be restarted", () => {
    const result = transition("closed", { attempt: 3, target: null }, { type: "start" });
    expect(result.state).toBe("discovering");
    expect(result.context.attempt).toBe(0);
  });

  it("close when already closed emits no actions", () => {
    expect(transition("closed", initialContext(), { type: "close" }).actions).toEqual([]);
  });
});

describe("ignored events", () => {
  it("stray events do not move the machine", () => {
    expect(transition("ready", initialContext(), { type: "backoffElapsed" }).state).toBe("ready");
    expect(transition("idle", initialContext(), { type: "socketClosed" }).state).toBe("idle");
  });
});
