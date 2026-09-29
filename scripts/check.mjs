// Spawns the built server over stdio (exactly like Claude does) and prints optimizer_connection_status.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string"));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "ignore" });
const client = new Client({ name: "setup-check", version: "0" });

const timer = setTimeout(() => {
  console.error("✘ Timed out after 90s talking to the server");
  process.exit(1);
}, 90_000);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`✔ Server starts, tools: ${tools.map((t) => t.name).join(", ")}\n`);
  const r = await client.callTool({ name: "optimizer_connection_status", arguments: {} });
  console.log(r.content.map((c) => c.text).join("\n"));
} catch (e) {
  console.error("✘ Server check failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
}
