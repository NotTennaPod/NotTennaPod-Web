// Builds the app and the server once before the journeys. With
// NTP_SERVER_BINARY set, the suites run a prebuilt server instead (the
// release candidate of PROTOCOL §16): it is checked, never rebuilt.
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const serverRepo = process.env.NTP_SERVER ?? join(root, "..", "NotTennaPod-Server");
/** candidate is the prebuilt server binary to run, if one was given. */
const candidate = process.env.NTP_SERVER_BINARY ? resolve(process.env.NTP_SERVER_BINARY) : undefined;
export const serverBinary = candidate ?? join(root, ".work", "e2e-server");

export default function build(): void {
  execFileSync("node", ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
  mkdirSync(join(root, ".work"), { recursive: true });
  if (candidate) {
    try {
      if (!statSync(candidate).isFile()) throw new Error("not a file");
      accessSync(candidate, constants.X_OK);
    } catch (e) {
      throw new Error(`NTP_SERVER_BINARY=${candidate} is not an executable server binary: ${e instanceof Error ? e.message : String(e)}`);
    }
    const version = execFileSync(candidate, ["version"], { encoding: "utf8" }).trim();
    console.log(`Running the suites on the prebuilt server ${candidate} (${version}).`);
    return;
  }
  const go = join(serverRepo, ".work", "toolchains", "go", "bin");
  execFileSync("go", ["build", "-o", serverBinary, "./cmd/nottennapod-server"], {
    cwd: serverRepo,
    stdio: "inherit",
    env: { ...process.env, PATH: `${go}:${process.env.PATH}` },
  });
}
