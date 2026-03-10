#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";

type Config = {
  barkUrl?: string;
};

type SessionRecord = {
  completedAt: string;
  minutes: number;
};

type Store = {
  config: Config;
  sessions: SessionRecord[];
};

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

const DATA_DIR =
  process.env.POM_TOOL_DATA_DIR || path.join(os.homedir(), ".pom-tool");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const COLOR_ENABLED =
  process.stdout.isTTY &&
  !("NO_COLOR" in process.env) &&
  process.env.TERM !== "dumb";
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "status") {
    await showStatus();
    return;
  }

  if (command === "bark") {
    await configureBark(args.slice(1));
    return;
  }

  const minutes = Number(command);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    console.error(`Invalid argument: "${command}"`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  await runPomodoro(minutes);
}

function printHelp(): void {
  console.log(
    renderPanel("pom-tool", [
      `${label("Usage")}  ${style("pom <minutes>", "cyan")}        Start a Pomodoro timer`,
      `       ${style("pom status", "cyan")}           Show Pomodoro averages`,
      `       ${style("pom bark [--url URL]", "cyan")} Configure Bark notifications`,
    ]),
  );
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readStore(): Promise<Store> {
  const [config, sessions] = await Promise.all([
    readJsonFile<Config>(CONFIG_PATH, {}),
    readJsonFile<SessionRecord[]>(SESSIONS_PATH, []),
  ]);

  return { config, sessions };
}

async function saveConfig(config: Config): Promise<void> {
  await writeJsonFile(CONFIG_PATH, config);
}

async function appendSession(record: SessionRecord): Promise<void> {
  const sessions = await readJsonFile<SessionRecord[]>(SESSIONS_PATH, []);
  sessions.push(record);
  await writeJsonFile(SESSIONS_PATH, sessions);
}

async function configureBark(args: string[]): Promise<void> {
  const inlineUrl = readFlagValue(args, "--url");
  const currentConfig = await readJsonFile<Config>(CONFIG_PATH, {});
  const barkUrl = inlineUrl ?? (await promptForBarkUrl(currentConfig.barkUrl));

  if (!barkUrl) {
    console.log(style("Bark setup cancelled.", "yellow"));
    return;
  }

  validateBarkUrl(barkUrl);
  await saveConfig({ ...currentConfig, barkUrl });
  console.log(
    renderPanel("Bark", [
      `${label("Status")} ${style("saved", "green")}`,
      `${label("URL")}    ${maskBarkUrl(barkUrl)}`,
    ]),
  );
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

async function promptForBarkUrl(
  existingUrl?: string,
): Promise<string | undefined> {
  const rl = readline.createInterface({ input, output });

  try {
    const hint = existingUrl ? ` [current: ${existingUrl}]` : "";
    const answer = await rl.question(`Enter Bark URL${hint}: `);
    const nextUrl = answer.trim();
    return nextUrl || existingUrl;
  } finally {
    rl.close();
  }
}

function validateBarkUrl(barkUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(barkUrl);
  } catch {
    throw new Error("Bark URL is not a valid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Bark URL must use http or https.");
  }
}

async function runPomodoro(minutes: number): Promise<void> {
  const { config } = await readStore();
  const totalSeconds = minutes * 60;
  const startedAt = new Date();

  console.log(
    renderPanel("🍅 Pomodoro", [
      `${label("Duration")} ${style(formatMinutes(minutes), "cyan")}`,
      `${label("Started")}  ${formatClockTime(startedAt)}`,
      `${label("Bark")}     ${config.barkUrl ? style("enabled", "green") : style("disabled", "gray")}`,
    ]),
  );

  const interrupted = await startCountdown(totalSeconds);
  if (interrupted) {
    console.log(`\n${style("Pomodoro cancelled.", "yellow")}`);
    process.exitCode = 130;
    return;
  }

  const finishedAt = new Date();
  await appendSession({
    completedAt: toIsoSeconds(finishedAt),
    minutes,
  });
  await notifyPomodoroFinished(minutes, finishedAt);

  process.stdout.write("\n");
  console.log(
    renderPanel("🍅 Completed", [
      `${label("Logged")}   ${style(formatMinutes(minutes), "green")}`,
      `${label("Finished")} ${formatClockTime(finishedAt)}`,
      `${label("Saved")}    ${style("session recorded", "green")}`,
    ]),
  );
  await sendBarkNotification(
    config.barkUrl,
    "Pomodoro finished",
    `${minutes} minute${minutes === 1 ? "" : "s"} completed at ${formatClockTime(finishedAt)}`,
  );
}

async function startCountdown(totalSeconds: number): Promise<boolean> {
  let interrupted = false;

  const onSigint = (): void => {
    interrupted = true;
  };

  process.once("SIGINT", onSigint);

  try {
    for (let remaining = totalSeconds; remaining >= 0; remaining -= 1) {
      renderRemaining(remaining);
      if (remaining === 0) {
        break;
      }

      await sleep(1000);
      if (interrupted) {
        return true;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }

  return interrupted;
}

function renderRemaining(totalSeconds: number): void {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const timestamp = `${pad(minutes)}:${pad(seconds)}`;
  const reset = COLOR_ENABLED ? ANSI.reset : "";
  process.stdout.write(
    `\r⏳ ${style("Timer", "blue")} ${style(timestamp, totalSeconds <= 10 ? "yellow" : "cyan")}${reset}`,
  );
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBarkNotification(
  barkUrl: string | undefined,
  title: string,
  body: string,
): Promise<void> {
  if (!barkUrl) {
    return;
  }

  try {
    const url = new URL(barkUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      console.warn(`Bark notification failed with status ${response.status}.`);
    }
  } catch (error) {
    console.warn(`Bark notification failed: ${(error as Error).message}`);
  }
}

async function notifyPomodoroFinished(
  minutes: number,
  finishedAt: Date,
): Promise<void> {
  playTerminalBell();
  await maybeSendSystemNotification(minutes, finishedAt);
}

function playTerminalBell(): void {
  process.stdout.write("\u0007");
}

async function maybeSendSystemNotification(
  minutes: number,
  finishedAt: Date,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const message = `Pomodoro finished. ${formatMinutes(minutes)} completed at ${formatClockTime(finishedAt)}.`;

  try {
    await execFileAsync("/usr/bin/say", [message]);
  } catch {
    // Best-effort only. Terminal bell already fired.
  }
}

async function showStatus(): Promise<void> {
  const { config, sessions } = await readStore();
  const today = new Date();

  const todayTotal = sumMinutesSince(sessions, startOfDay(today));
  const last7Total = sumMinutesSince(sessions, daysAgo(today, 6));
  const last30Total = sumMinutesSince(sessions, daysAgo(today, 29));
  const lastSession = getLastSession(sessions);

  console.log(
    renderPanel("Pomodoro Status", [
      `${label("Today")}     ${style(formatMinutesDecimal(todayTotal), "green")}`,
      `${label("7d avg")}    ${style(`${formatMinutesDecimal(last7Total / 7)}/day`, "cyan")}`,
      `${label("30d avg")}   ${style(`${formatMinutesDecimal(last30Total / 30)}/day`, "cyan")}`,
      `${label("Sessions")}  ${style(String(sessions.length), "blue")}`,
      `${label("Bark")}      ${config.barkUrl ? style("configured", "green") : style("not configured", "gray")}`,
      `${label("Last done")} ${lastSession ? formatSessionTime(lastSession.completedAt) : style("none yet", "gray")}`,
    ]),
  );
}

function sumMinutesSince(sessions: SessionRecord[], since: Date): number {
  return sessions.reduce((total, session) => {
    const completedAt = new Date(session.completedAt);
    return completedAt >= since ? total + session.minutes : total;
  }, 0);
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function daysAgo(date: Date, days: number): Date {
  const next = startOfDay(date);
  next.setDate(next.getDate() - days);
  return next;
}

function getLastSession(sessions: SessionRecord[]): SessionRecord | undefined {
  return sessions.reduce<SessionRecord | undefined>((latest, session) => {
    if (!latest) {
      return session;
    }

    return new Date(session.completedAt) > new Date(latest.completedAt)
      ? session
      : latest;
  }, undefined);
}

function formatSessionTime(value: string): string {
  return new Date(value).toLocaleString([], {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatMinutes(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatMinutesDecimal(minutes: number): string {
  return `${minutes.toFixed(1)} min`;
}

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toIsoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function label(text: string): string {
  return style(text.padEnd(9, " "), "gray");
}

function renderPanel(title: string, lines: string[]): string {
  const width = Math.max(
    title.length,
    ...lines.map(stripAnsi).map((line) => line.length),
  );
  const top = `+${"-".repeat(width + 2)}+`;
  const header = `| ${style(title.padEnd(width, " "), "bold")} |`;
  const body = lines.map((line) => `| ${padAnsi(line, width)} |`);
  return [top, header, top, ...body, top].join("\n");
}

function padAnsi(value: string, width: number): string {
  const visible = stripAnsi(value).length;
  return `${value}${" ".repeat(Math.max(0, width - visible))}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function style(text: string, color: keyof typeof ANSI): string {
  if (!COLOR_ENABLED) {
    return text;
  }

  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function maskBarkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const key = pathParts[pathParts.length - 1] ?? "";
    const maskedKey =
      key.length <= 6 ? "***" : `${key.slice(0, 3)}...${key.slice(-3)}`;
    return `${parsed.origin}/${maskedKey}`;
  } catch {
    return url;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
