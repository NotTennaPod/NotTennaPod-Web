// Copies dist/ into NotTennaPod-Server's internal/webui/dist, which the
// server embeds. NTP_SERVER names the server checkout (default ../NotTennaPod-Server).
// The server tracks only the empty .keep there, which this recreates unchanged.
import { cpSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = process.env.NTP_SERVER ?? join(root, "..", "NotTennaPod-Server");
const target = join(server, "internal", "webui", "dist");
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("install-into-server: build first (npm run build)");
  process.exit(1);
}
if (!existsSync(join(server, "internal", "webui"))) {
  console.error(`install-into-server: ${server} is not a NotTennaPod-Server checkout`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(join(root, "dist"), target, { recursive: true });
writeFileSync(join(target, ".keep"), "");
console.log(`install-into-server: copied dist/ to ${target}`);
