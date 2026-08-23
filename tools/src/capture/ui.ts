/**
 * Terminal UI helpers for the capture wizard: prompts, y/n questions,
 * countdowns, and consistent styling. Everything funnels through one
 * readline interface so Ctrl+C stays clean.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import pc from "picocolors";

let rl: Interface | null = null;
let closeSignal: Promise<never> | null = null;

export function ui(): Interface {
  if (rl === null) {
    const iface = createInterface({ input: stdin, output: stdout });
    rl = iface;
    // A question pending when stdin ends would otherwise never settle;
    // ask() races every question against this rejection.
    closeSignal = new Promise((_, reject) => iface.once("close", () => reject(new InputEnded())));
    closeSignal.catch(() => {});
  }
  return rl;
}

export function closeUi(): void {
  const iface = rl;
  rl = null;
  closeSignal = null;
  iface?.removeAllListeners("close");
  iface?.close();
}

export const style = {
  title: (text: string): string => pc.bold(pc.cyan(text)),
  step: (text: string): string => pc.bold(pc.white(text)),
  ok: (text: string): string => pc.green(text),
  warn: (text: string): string => pc.yellow(text),
  bad: (text: string): string => pc.red(text),
  dim: (text: string): string => pc.dim(text),
  key: (text: string): string => pc.bold(pc.magenta(text)),
};

export function header(text: string): void {
  console.log("");
  console.log(style.title(`━━━ ${text} ${"━".repeat(Math.max(0, 60 - text.length))}`));
}

export function bullet(text: string): void {
  console.log(`  • ${text}`);
}

/** Thrown when stdin ends (piped input exhausted, terminal closed). */
export class InputEnded extends Error {
  constructor() {
    super("input ended");
  }
}

/** Ask a free-form question. Throws InputEnded when stdin is gone. */
export async function ask(question: string): Promise<string> {
  const iface = ui();
  const signal = closeSignal!;
  try {
    const answer = await Promise.race([iface.question(`${question} `), signal]);
    return answer.trim();
  } catch (error) {
    if (error instanceof InputEnded) throw error;
    if (error instanceof Error && (error.message.includes("closed") || error.name === "AbortError")) {
      throw new InputEnded();
    }
    throw error;
  }
}

/** Ask until y or n. */
export async function yesNo(question: string): Promise<boolean> {
  for (;;) {
    const answer = (await ask(`${question} ${style.dim("[y/n]")}`)).toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log(style.warn("  Please answer y or n."));
  }
}

/** Wait for Enter, returning any command letter typed before it. */
export async function pressEnter(prompt: string): Promise<string> {
  return (await ask(prompt)).toLowerCase();
}

/** Visible countdown that resolves when the time is up. */
export async function countdown(label: string, ms: number): Promise<void> {
  const seconds = Math.ceil(ms / 1000);
  for (let remaining = seconds; remaining > 0; remaining--) {
    stdout.write(`\r  ${label} ${style.dim(`${remaining}s remaining...`)}   `);
    await sleep(1000);
  }
  stdout.write(`\r  ${label} ${style.ok("done")}                    \n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
