import path from "node:path";
import {AvlabError} from "./errors.js";

export function normalizeRelative(input: string): string {
  const normalized = input.split(path.sep).join("/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new AvlabError("AVLAB_UNSAFE_PATH", `Unsafe project path: ${input}`);
  }
  return normalized;
}

export function fromRelative(root: string, relative: string): string {
  const safe = normalizeRelative(relative);
  const resolved = safe === "." ? path.resolve(root) : path.resolve(root, ...safe.split("/"));
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new AvlabError("AVLAB_UNSAFE_PATH", `Path escapes project: ${relative}`);
  }
  return resolved;
}
