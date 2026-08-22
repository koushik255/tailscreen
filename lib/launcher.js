import { spawn } from "node:child_process";
import process from "node:process";

export function getLaunchSpec(filePath, env = process.env, platform = process.platform) {
  if (env.PLAYER_COMMAND) {
    let configuredArgs = ["{file}"];
    if (env.PLAYER_ARGS_JSON) {
      const parsed = JSON.parse(env.PLAYER_ARGS_JSON);
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
        throw new Error("PLAYER_ARGS_JSON must be a JSON array of strings");
      }
      configuredArgs = parsed;
    }

    return {
      command: env.PLAYER_COMMAND,
      args: configuredArgs.map((argument) => argument.replaceAll("{file}", filePath)),
    };
  }

  if (platform === "darwin") return { command: "open", args: [filePath] };
  if (platform === "linux") return { command: "xdg-open", args: [filePath] };

  throw new Error("Set PLAYER_COMMAND and PLAYER_ARGS_JSON for this operating system");
}

export function launchMedia(filePath, options = {}) {
  const { command, args } = getLaunchSpec(filePath, options.env, options.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ command, args });
    });
  });
}
