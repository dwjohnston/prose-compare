#!/usr/bin/env bun
// Used by the deploy job: make sure the D1 database, R2 bucket and queue exist (creating them on the first
// deploy), then write the D1 database_id into wrangler.jsonc in the CI checkout so the repo itself holds no
// account-specific IDs. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DB_NAME = "prose-compare";
const BUCKET = "prose-compare-blobs";
const QUEUE = "prose-compare-lanes";
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

function wrangler(args: string[], { allowFail = false } = {}): { ok: boolean; out: string } {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) {
    console.error(out);
    throw new Error(`wrangler ${args.join(" ")} failed`);
  }
  return { ok: r.status === 0, out };
}

function findDatabaseId(): string | undefined {
  const { out } = wrangler(["d1", "list", "--json"]);
  const start = out.indexOf("[");
  const list = JSON.parse(out.slice(start)) as { name: string; uuid: string }[];
  return list.find((d) => d.name === DB_NAME)?.uuid;
}

let id = findDatabaseId();
if (!id) {
  console.log(`Creating D1 database ${DB_NAME}`);
  wrangler(["d1", "create", DB_NAME]);
  id = findDatabaseId();
  if (!id) throw new Error("D1 database not found after create");
}

for (const [label, args] of [
  ["R2 bucket", ["r2", "bucket", "create", BUCKET]],
  ["queue", ["queues", "create", QUEUE]],
] as const) {
  const r = wrangler([...args], { allowFail: true });
  if (r.ok) console.log(`Created ${label}`);
  else if (/already exists|already owned|exists/i.test(r.out)) console.log(`${label} exists`);
  else {
    console.error(r.out);
    throw new Error(`Couldn't create ${label}`);
  }
}

const config = readFileSync("wrangler.jsonc", "utf8");
if (!config.includes(PLACEHOLDER_ID)) throw new Error("wrangler.jsonc has no database_id placeholder to fill");
writeFileSync("wrangler.jsonc", config.replace(PLACEHOLDER_ID, id));
console.log("D1 database_id written to wrangler.jsonc (CI checkout only)");
