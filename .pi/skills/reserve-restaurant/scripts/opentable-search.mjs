#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_HELPER = `${process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT ?? process.cwd()}/.pi/skills/agent-browser/scripts/stock-chrome.mjs`;

export function buildReservationUrl(baseUrl, { date, time, covers }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid time: ${time}`);
  if (!Number.isInteger(covers) || covers < 1) throw new Error(`Invalid party size: ${covers}`);

  const url = new URL(baseUrl);
  url.searchParams.set("dateTime", `${date}T${time}:00`);
  url.searchParams.set("covers", String(covers));
  return url.toString();
}

export function parseAvailability(snapshot) {
  const results = [];
  const pattern = /button "(Reserve table at .*? at (\d{1,2}:\d{2} [AP]M) on .*? for a party of \d+.*?)"/g;
  for (const match of snapshot.matchAll(pattern)) {
    results.push({ time: match[2], label: match[1] });
  }
  return results;
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
      args.restaurants.push({ name: value.slice(0, separator), url: value.slice(separator + 1) });
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
  });
  return result.stdout;
}

async function search(args) {
  const helper = process.env.PI_AGENT_BROWSER_HELPER ?? DEFAULT_HELPER;
  const session = args.session ?? "default";
  await execFileAsync("node", [helper, "start", session]);

  const tabs = [];
  try {
    for (const restaurant of args.restaurants) {
      const url = buildReservationUrl(restaurant.url, args);
      await runHelper(helper, session, "tab", "new", url);
      const tabState = JSON.parse(await runHelper(helper, session, "tab", "--json"));
      const active = tabState.data?.tabs?.find((tab) => tab.active);
      if (active) tabs.push({ ...restaurant, tabId: active.tabId, url });
    }

    const results = [];
    for (const tab of tabs) {
      await runHelper(helper, session, "tab", tab.tabId);
      await runHelper(helper, session, "wait", "1500");
      try {
        await runHelper(helper, session, "wait", "--load", "networkidle");
      } catch {
        // OpenTable can keep analytics requests open; the snapshot is still useful.
      }
      const snapshot = await runHelper(helper, session, "snapshot", "-i");
      results.push({ ...tab, availability: parseAvailability(snapshot) });
    }
    return results;
  } finally {
    await execFileAsync("node", [helper, "stop", session]).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(usage());
    else console.log(JSON.stringify(await search(args), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
