import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reads `.env` from the working directory into process.env.
 *
 * The deploy guide, `.env.example` and the systemd unit all point at this file,
 * but only systemd was ever reading it - so `npm run seed`, which the guide runs
 * as a plain shell command, never saw SEED_PASSWORD and quietly used the default
 * password published in the README. The operator had no way to tell.
 *
 * Values already in the environment win, so `PORT=4001 node server/index.js`
 * still overrides the file, and systemd's EnvironmentFile keeps working.
 */
export function loadEnvFile(path = resolve(process.cwd(), '.env')) {
  if (!existsSync(path)) return {};

  const loaded = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // A quoted value keeps its spaces and its trailing comment.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    if (!(key in process.env)) {
      process.env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

/*
 * Runs on import, not on call. ES module imports are hoisted, so a loadEnvFile()
 * statement placed among the imports of the entry point would run after db.js
 * had already resolved DATABASE_PATH. Importing this module first is the only
 * ordering the language guarantees.
 */
loadEnvFile();
