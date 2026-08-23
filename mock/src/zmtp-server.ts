/**
 * Server side of the ZMTP 3.0 handshake, mimicking the Stadium's behaviour:
 * exchange 64-byte NULL greetings, answer the client's READY command with a
 * ROUTER READY, and (on the update port) accept a SUBSCRIBE data frame.
 */

import type { Socket } from "node:net";
import {
  ZmtpFrameParser,
  buildGreeting,
  encodeFrame,
  encodeReadyPayload,
  isCommandFrame,
  parseCommandPayload,
  validateGreeting,
  ZMTP_FLAG_COMMAND,
  ZMTP_GREETING_SIZE,
  type ZmtpFrame,
} from "@stadium-deck/protocol";

export interface ZmtpServerConnection {
  socket: Socket;
  sendFrame(payload: Uint8Array, flags?: number): void;
  /** Client's READY Socket-Type ("SUB" | "DEALER" in practice). */
  clientSocketType: string | null;
}

type FrameHandler = (frame: ZmtpFrame, conn: ZmtpServerConnection) => void;

/**
 * Drive one accepted TCP connection through the ZMTP handshake, then deliver
 * data frames to `onFrame`. Resolves once the handshake (greeting + READY)
 * completes. The Stadium resets connections that skip the handshake; we are
 * slightly friendlier and just destroy the socket on garbage.
 */
export function serveZmtpConnection(
  socket: Socket,
  onFrame: FrameHandler,
  onHandshake?: (conn: ZmtpServerConnection) => void,
): ZmtpServerConnection {
  const parser = new ZmtpFrameParser();
  let greetingBuf: Uint8Array = new Uint8Array(0);
  let phase: "greeting" | "ready" | "open" = "greeting";

  const conn: ZmtpServerConnection = {
    socket,
    clientSocketType: null,
    sendFrame(payload: Uint8Array, flags = 0x00): void {
      if (!socket.destroyed) {
        socket.write(encodeFrame(payload, flags));
      }
    },
  };

  socket.on("data", (chunk: Buffer) => {
    try {
      handleData(new Uint8Array(chunk));
    } catch {
      socket.destroy();
    }
  });

  function handleData(data: Uint8Array): void {
    if (phase === "greeting") {
      const merged = new Uint8Array(greetingBuf.length + data.length);
      merged.set(greetingBuf);
      merged.set(data, greetingBuf.length);
      greetingBuf = merged;
      if (greetingBuf.length < ZMTP_GREETING_SIZE) return;
      const greeting = greetingBuf.subarray(0, ZMTP_GREETING_SIZE);
      if (!validateGreeting(greeting).ok) {
        socket.destroy();
        return;
      }
      const serverGreeting = buildGreeting();
      serverGreeting[32] = 0x01; // as-server
      socket.write(serverGreeting);
      phase = "ready";
      const rest = greetingBuf.subarray(ZMTP_GREETING_SIZE);
      greetingBuf = new Uint8Array(0);
      if (rest.length > 0) handleFrames(parser.feed(rest));
      return;
    }
    handleFrames(parser.feed(data));
  }

  function handleFrames(frames: ZmtpFrame[]): void {
    for (const frame of frames) {
      if (phase === "ready") {
        if (!isCommandFrame(frame)) {
          socket.destroy();
          return;
        }
        const command = parseCommandPayload(frame.payload);
        if (command === null || command.name !== "READY") {
          socket.destroy();
          return;
        }
        const socketType = command.properties.get("Socket-Type");
        conn.clientSocketType = socketType ? new TextDecoder().decode(socketType) : null;
        conn.sendFrame(encodeReadyPayload("ROUTER"), ZMTP_FLAG_COMMAND);
        phase = "open";
        onHandshake?.(conn);
        continue;
      }
      if (phase === "open") {
        if (isCommandFrame(frame)) continue; // PING/PONG etc: ignore
        onFrame(frame, conn);
      }
    }
  }

  return conn;
}
