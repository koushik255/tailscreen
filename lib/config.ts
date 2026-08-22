import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export type LibraryConfig = { name: string; path: string };
export type AppConfig = {
  port: number;
  scanIntervalMs: number;
  extraThresholdMb: number;
  libraries: LibraryConfig[];
};

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function normalizeLibraries(libraries: unknown): LibraryConfig[] {
  if (!Array.isArray(libraries)) throw new Error("libraries must be an array");

  return libraries.map((value, index) => {
    const library = value as Partial<LibraryConfig> | null;
    if (!library || typeof library.name !== "string" || !library.name.trim()) {
      throw new Error(`libraries[${index}].name must be a non-empty string`);
    }
    if (typeof library.path !== "string" || !path.isAbsolute(library.path)) {
      throw new Error(`libraries[${index}].path must be an absolute path`);
    }
    return { name: library.name.trim(), path: path.resolve(library.path) };
  });
}

export function normalizeConfig(
  raw: Partial<AppConfig> = {},
  env: Record<string, string | undefined> = {},
): AppConfig {
  const environmentLibraries = (env.MEDIA_DIRS || "")
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => ({ name: path.basename(directory), path: directory }));

  return {
    port: positiveInteger(env.PORT, raw.port ?? 8787, "port"),
    scanIntervalMs: positiveInteger(env.SCAN_INTERVAL_MS, raw.scanIntervalMs ?? 30000, "scanIntervalMs"),
    extraThresholdMb: positiveInteger(env.EXTRA_THRESHOLD_MB, raw.extraThresholdMb ?? 800, "extraThresholdMb"),
    libraries: normalizeLibraries(environmentLibraries.length ? environmentLibraries : (raw.libraries ?? [])),
  };
}

export async function loadConfig(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): Promise<AppConfig & { configPath: string }> {
  const env = options.env ?? process.env;
  const workingDirectory = options.cwd ?? process.cwd();
  const configPath = path.resolve(workingDirectory, env.CONFIG_PATH || "config.json");
  let raw: Partial<AppConfig> = {};

  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<AppConfig>;
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code !== "ENOENT") {
      throw new Error(`Could not load ${configPath}: ${cause.message}`, { cause });
    }
  }

  return { ...normalizeConfig(raw, env), configPath };
}
