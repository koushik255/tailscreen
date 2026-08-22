import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeLibraries(libraries) {
  if (!Array.isArray(libraries)) throw new Error("libraries must be an array");

  return libraries.map((library, index) => {
    if (!library || typeof library.name !== "string" || !library.name.trim()) {
      throw new Error(`libraries[${index}].name must be a non-empty string`);
    }
    if (typeof library.path !== "string" || !path.isAbsolute(library.path)) {
      throw new Error(`libraries[${index}].path must be an absolute path`);
    }
    return { name: library.name.trim(), path: path.resolve(library.path) };
  });
}

function normalizePlayer(player) {
  if (player == null) return null;
  if (typeof player !== "object" || typeof player.command !== "string" || !player.command.trim()) {
    throw new Error("player.command must be a non-empty string");
  }
  const args = player.args ?? ["{file}"];
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("player.args must be an array of strings");
  }
  return { command: player.command, args };
}

export function normalizeConfig(raw = {}, env = {}) {
  const environmentLibraries = (env.MEDIA_DIRS || "")
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => ({ name: path.basename(directory), path: directory }));

  let player = raw.player;
  if (env.PLAYER_COMMAND) {
    player = {
      command: env.PLAYER_COMMAND,
      args: env.PLAYER_ARGS_JSON ? JSON.parse(env.PLAYER_ARGS_JSON) : ["{file}"],
    };
  }

  return {
    port: positiveInteger(env.PORT, raw.port ?? 8787, "port"),
    scanIntervalMs: positiveInteger(
      env.SCAN_INTERVAL_MS,
      raw.scanIntervalMs ?? 30000,
      "scanIntervalMs",
    ),
    extraThresholdMb: positiveInteger(
      env.EXTRA_THRESHOLD_MB,
      raw.extraThresholdMb ?? 800,
      "extraThresholdMb",
    ),
    libraries: normalizeLibraries(environmentLibraries.length ? environmentLibraries : (raw.libraries ?? [])),
    player: normalizePlayer(player),
  };
}

export async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const workingDirectory = options.cwd ?? process.cwd();
  const configPath = path.resolve(workingDirectory, env.CONFIG_PATH || "config.json");
  let raw = {};

  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not load ${configPath}: ${error.message}`, { cause: error });
    }
  }

  return { ...normalizeConfig(raw, env), configPath };
}
