#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const DEFAULT_HELPER = `${process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT ?? process.cwd()}/.pi/skills/agent-browser/scripts/stock-chrome.mjs`;

export function buildReservationUrl(baseUrl, { date, time, covers }) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dateMatch) throw new Error(`Invalid date: ${date}`);
  const [, year, month, day] = dateMatch.map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${date}`);
  }
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) {
    throw new Error(`Invalid time: ${time}`);
  }
  if (!Number.isInteger(covers) || covers < 1 || covers > 20) {
    throw new Error(`Invalid party size: ${covers}`);
  }

  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.opentable.com" ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/r\/[^/]+\/?$/.test(url.pathname)
  ) {
    throw new Error(`Restaurant URL must be a direct HTTPS OpenTable restaurant URL: ${baseUrl}`);
  }
  url.searchParams.set("dateTime", `${date}T${time}:00`);
  url.searchParams.set("covers", String(covers));
  return url.toString();
}

export function parseAvailability(snapshot, request) {
  const results = [];
  const pattern = /button "(Reserve table at .*? at (\d{1,2}:\d{2} [AP]M) on (.*?),? for a party of (\d+)\b.*?)"/g;
  for (const match of snapshot.matchAll(pattern)) {
    if (request) {
      const date = new Date(`${request.date}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || Number(match[4]) !== request.covers) continue;
      const monthDay = date.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      if (match[3] !== monthDay && match[3] !== `${monthDay}, ${date.getUTCFullYear()}`) continue;
    }
    results.push({ time: match[2], label: match[1] });
  }
  return results;
}

export function analyzeSnapshot(snapshot, request) {
  if (/access denied|captcha|verify you are human|this site can.t be reached|err_/i.test(snapshot)) {
    return { status: "blocked", availability: [] };
  }
  const availability = parseAvailability(snapshot, request);
  if (availability.length > 0) return { status: "available", availability };
  if (request && parseAvailability(snapshot).length > 0) return { status: "unverified", availability };
  if (!snapshot.trim()) return { status: "unverified", availability };
  return { status: "no_slots_visible", availability };
}

function usage() {
  return `Usage:
  node scripts/opentable-search.mjs --date YYYY-MM-DD --time HH:MM --covers N \\
    --restaurant "Name|https://www.opentable.com/r/slug" [--restaurant ...]

This checks public OpenTable availability only. It never clicks a reservation button.`;
}

function parseArgs(argv) {
  const args = { restaurants: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true, ...args };
    if (!arg.startsWith("--") || index + 1 >= argv.length) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[++index];
    if (arg === "--restaurant") {
      const separator = value.indexOf("|");
      if (separator < 1) throw new Error(`Restaurant must be Name|URL: ${value}`);
      const name = value.slice(0, separator).trim();
      if (!name || name.length > 100 || args.restaurants.length >= 10) {
        throw new Error("Restaurant names must be 1-100 characters; at most 10 are allowed");
      }
      const url = value.slice(separator + 1);
      buildReservationUrl(url, {
        date: args.date ?? "2000-01-01",
        time: args.time ?? "00:00",
        covers: args.covers ?? 1,
      });
      args.restaurants.push({ name, url });
    } else if (arg === "--covers") {
      args.covers = Number(value);
    } else if (arg === "--date" || arg === "--time" || arg === "--session") {
      args[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.date || !args.time || !args.covers || args.restaurants.length === 0) throw new Error(usage());
  return args;
}

async function runHelper(helper, session, command, ...args) {
  const result = await execFileAsync("node", [helper, "run", session, "--", command, ...args], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 35_000,
  });
  return result.stdout;
}

export async function searchOpenTable(args) {
  const helper = process.env.PI_AGENT_BROWSER_HELPER ?? DEFAULT_HELPER;
  const session = args.session ?? "default";
  const started = JSON.parse(
    (await execFileAsync("node", [helper, "start", session], { timeout: 20_000 })).stdout,
  );
  const ownedLaunch = started.created === true && typeof started.launchId === "string" && started.launchId.length > 0
    ? started.launchId : undefined;

  const tabs = [];
  try {
    for (const [index, restaurant] of args.restaurants.entries()) {
      const url = buildReservationUrl(restaurant.url, args);
      const tabId = `ot-${process.pid}-${index}`;
      await runHelper(helper, session, "tab", "new", "--label", tabId, url);
      tabs.push({ ...restaurant, tabId, url });
    }

    const results = [];
    for (const tab of tabs) {
      await runHelper(helper, session, "tab", tab.tabId);
      await runHelper(helper, session, "wait", "3000");
      const snapshot = await runHelper(helper, session, "snapshot", "-i");
      results.push({
        ...tab,
        ...analyzeSnapshot(snapshot, args),
        checkedAt: new Date().toISOString(),
      });
    }
    return results;
  } finally {
    for (const tab of tabs.reverse()) {
      await runHelper(helper, session, "tab", "close", tab.tabId).catch(() => undefined);
    }
    if (ownedLaunch) {
      await execFileAsync("node", [helper, "stop", session, "--if-launch", ownedLaunch], { timeout: 10_000 }).catch(
        () => undefined,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(usage());
    else console.log(JSON.stringify(await searchOpenTable(args), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
