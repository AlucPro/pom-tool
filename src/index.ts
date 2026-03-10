#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };

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
  magenta: "\u001b[35m",
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

  if (command === "-v" || command === "--version") {
    printVersion();
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
    renderKeyValuePanel("pom-tool", [
      ["Usage", `${style("pom <minutes>", "cyan")}  Start a Pomodoro timer`],
      ["", `${style("pom status", "cyan")}  Show Pomodoro averages`],
      ["", `${style("pom bark [--url URL]", "cyan")}  Configure Bark notifications`],
      ["", `${style("pom -v", "cyan")}  Show current version`],
    ]),
  );
}

function printVersion(): void {
  console.log(packageJson.version);
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
    renderKeyValuePanel("Bark", [
      ["Status", style("saved", "green")],
      ["URL", maskBarkUrl(barkUrl)],
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
  renderPomodoroHeader(minutes, Boolean(config.barkUrl));

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
  await renderCompletionAnimation(totalSeconds);
  await notifyPomodoroFinished(minutes, finishedAt);

  process.stdout.write("\n");
  console.log(
    renderKeyValuePanel("🍅 Completed", [
      ["Logged", style(formatMinutes(minutes), "green")],
      ["Finished", formatClockTime(finishedAt)],
      ["Saved", style("session recorded", "green")],
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
      renderRemaining(remaining, totalSeconds);
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

function renderPomodoroHeader(minutes: number, barkEnabled: boolean): void {
  const barkLabel = barkEnabled ? style("bark on", "blue") : style("bark off", "gray");
  console.log(
    `${style("pom", "bold")} ${style(formatMinutes(minutes), "gray")} ${style("·", "gray")} ${barkLabel}`,
  );
}

function renderRemaining(remainingSeconds: number, totalSeconds: number): void {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const elapsedSeconds = totalSeconds - remainingSeconds;
  const percent = totalSeconds === 0 ? 100 : Math.round((elapsedSeconds / totalSeconds) * 100);
  const timestamp = `${pad(minutes)}:${pad(seconds)}`;
  const progressColor = getProgressColor(remainingSeconds, totalSeconds);
  const phase = getProgressPhase(remainingSeconds, totalSeconds);
  const progressBar = buildProgressBar(
    elapsedSeconds,
    totalSeconds,
    24,
    progressColor,
    phase.trackColor,
  );
  const reset = COLOR_ENABLED ? ANSI.reset : "";
  const phaseBadge = style(`[${phase.label.toUpperCase()}]`, phase.color);
  process.stdout.write(
    `\r\u001b[2K${style("◐", phase.dotColor)} ${style(timestamp, progressColor)} ${progressBar} ${style(`${padPercent(percent)}%`, phase.color)} ${phaseBadge}${reset}`,
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

async function renderCompletionAnimation(totalSeconds: number): Promise<void> {
  if (!process.stdout.isTTY) {
    return;
  }

  const frames = [
    { icon: "◐", color: "blue" as const, label: "Session complete" },
    { icon: "◓", color: "cyan" as const, label: "Deep work locked in" },
    { icon: "◑", color: "bold" as const, label: "Ready for a break" },
  ];

  for (const frame of frames) {
    const progressBar = `[${style("█".repeat(24), frame.color)}]`;
    process.stdout.write(
      `\r\u001b[2K${style(frame.icon, frame.color)} ${style("00:00", frame.color)} ${progressBar} ${style("100%", frame.color)} ${style(frame.label, frame.color)} ${style(formatDuration(totalSeconds), "gray")}`,
    );
    await sleep(180);
  }
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
    renderKeyValuePanel("Pomodoro Status", [
      ["Today", style(formatMinutesDecimal(todayTotal), "green")],
      ["7d avg", style(`${formatMinutesDecimal(last7Total / 7)}/day`, "cyan")],
      ["30d avg", style(`${formatMinutesDecimal(last30Total / 30)}/day`, "cyan")],
      ["Sessions", style(String(sessions.length), "blue")],
      ["Bark", config.barkUrl ? style("configured", "green") : style("not configured", "gray")],
      ["Last done", lastSession ? formatSessionTime(lastSession.completedAt) : style("none yet", "gray")],
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

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
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

function renderKeyValuePanel(
  title: string,
  rows: Array<[labelText: string, valueText: string]>,
): string {
  const labelWidth = Math.max(...rows.map(([labelText]) => labelText.length));
  const lines = rows.map(([labelText, valueText]) =>
    renderKeyValueLine(labelText, valueText, labelWidth),
  );
  return renderPanel(title, lines);
}

function renderKeyValueLine(
  labelText: string,
  valueText: string,
  labelWidth: number,
): string {
  const key = labelText ? style(labelText.padEnd(labelWidth, " "), "gray") : " ".repeat(labelWidth);
  return `${key}  ${valueText}`;
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

function buildProgressBar(
  elapsedSeconds: number,
  totalSeconds: number,
  width: number,
  color: keyof typeof ANSI,
  trackColor: keyof typeof ANSI,
): string {
  const ratio = totalSeconds === 0 ? 1 : elapsedSeconds / totalSeconds;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = width - filled;
  const filledBar = filled > 0 ? style("█".repeat(filled), color) : "";
  const emptyBar = empty > 0 ? style("░".repeat(empty), trackColor) : "";
  return `[${filledBar}${emptyBar}]`;
}

function getProgressColor(
  remainingSeconds: number,
  totalSeconds: number,
): keyof typeof ANSI {
  const ratio = totalSeconds === 0 ? 0 : remainingSeconds / totalSeconds;

  if (remainingSeconds <= 10 || ratio <= 0.1) {
    return "bold";
  }

  if (ratio <= 0.33) {
    return "cyan";
  }

  if (ratio <= 0.66) {
    return "blue";
  }

  return "gray";
}

function getProgressPhase(
  remainingSeconds: number,
  totalSeconds: number,
): {
  label: string;
  color: keyof typeof ANSI;
  dotColor: keyof typeof ANSI;
  trackColor: keyof typeof ANSI;
} {
  const ratio = totalSeconds === 0 ? 0 : remainingSeconds / totalSeconds;

  if (remainingSeconds <= 10 || ratio <= 0.1) {
    return {
      label: "finish",
      color: "bold",
      dotColor: "cyan",
      trackColor: "gray",
    };
  }

  if (ratio <= 0.33) {
    return {
      label: "push",
      color: "cyan",
      dotColor: "blue",
      trackColor: "gray",
    };
  }

  if (ratio <= 0.66) {
    return {
      label: "flow",
      color: "blue",
      dotColor: "gray",
      trackColor: "gray",
    };
  }

  return {
    label: "warmup",
    color: "gray",
    dotColor: "gray",
    trackColor: "gray",
  };
}

function padPercent(value: number): string {
  return value.toString().padStart(3, " ");
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
