// The process InSoulForge talks to. It reads one JSON file, connects out to InSoulForge as an Activity, and reaches the
// local Autoloop hub over HTTP. Nothing here listens on a port or imports the hub's source.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createService, hubClient, parseConfig, serve } from "./activity.ts";

const configFile =
  process.env.INSOULFORGE_ACTIVITY_CONFIG ?? resolve(dirname(fileURLToPath(import.meta.url)), "config.json");
if (!existsSync(configFile)) {
  console.error(`没有配置文件：${configFile}`);
  process.exit(1);
}
let config;
try {
  config = parseConfig(JSON.parse(readFileSync(configFile, "utf8")));
} catch (error) {
  console.error(`配置文件有问题：${(error as Error).message}`);
  process.exit(1);
}
const log = (line: string) => console.log(`${new Date().toISOString()} [insoulforge-activity] ${line}`);
const stop = new AbortController();
const finish = () => stop.abort();
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
process.on("uncaughtException", (error) => log(`stray error: ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => log(`stray rejection: ${(error as Error)?.stack ?? error}`));
log(`配置：${configFile}`);
await serve(config, createService(config, hubClient(config), log), log, stop.signal);
