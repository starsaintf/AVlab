import {randomBytes} from "node:crypto";

export function newId(prefix: "avp" | "avv" | "pkg" | "op" | "prv" | "prp" | "syn" | "cnf"): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = randomBytes(10).toString("hex");
  return `${prefix}_${time}${random}`;
}
