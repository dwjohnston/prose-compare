#!/usr/bin/env bun
// Make the bcrypt hash for APP_PASSWORD_HASH and store it as a Worker secret without it touching your
// shell history or the screen:
//
//   bun scripts/hash-password.ts | npx wrangler secret put APP_PASSWORD_HASH
//
// It prompts for the password on stderr (input hidden when run in a terminal) and writes only the hash
// to stdout.
import bcrypt from "bcryptjs";

const COST = 10;

async function readPassword(): Promise<string> {
  process.stderr.write("Password for the app (input hidden): ");
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  let value = "";
  for await (const chunk of stdin) {
    for (const ch of String(chunk)) {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        if (stdin.isTTY) stdin.setRawMode(false);
        process.stderr.write("\n");
        return value;
      }
      if (ch === "\u0003") process.exit(130);
      if (ch === "\u007f") value = value.slice(0, -1);
      else value += ch;
    }
  }
  return value;
}

const password = await readPassword();
if (password.length < 12) {
  process.stderr.write("Use at least 12 characters.\n");
  process.exit(1);
}
process.stdout.write(`${bcrypt.hashSync(password, COST)}\n`);
