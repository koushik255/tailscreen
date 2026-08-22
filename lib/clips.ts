import path from "node:path";

export function clipMediaPath(filePath: string, mediaRoot: string): string {
  const relative = path.relative(path.resolve(mediaRoot), path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Movie is outside the clipping media root: ${mediaRoot}`);
  }
  return relative.split(path.sep).join("/");
}

export function clipServiceUrl(baseUrl: URL, value: string): URL {
  const supplied = new URL(value, baseUrl);
  return new URL(`${supplied.pathname}${supplied.search}`, baseUrl);
}
