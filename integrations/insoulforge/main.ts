// The process InSoulForge talks to. It reads one JSON file, connects out to InSoulForge as an Activity, and reaches the
// local Autoloop hub over HTTP. Nothing here listens on a port or imports the hub's source.
import { existsSync, readFileSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createService, hubClient, parseConfig, serve, type Config } from "./activity.ts";

const configFile =
  process.env.INSOULFORGE_ACTIVITY_CONFIG ?? resolve(dirname(fileURLToPath(import.meta.url)), "config.json");
if (!existsSync(configFile)) {
  console.error(`没有配置文件：${configFile}`);
  process.exit(1);
}
function readConfig(file: string): Config {
  return parseConfig(JSON.parse(readFileSync(file, "utf8")));
}
let config: Config;
try {
  config = readConfig(configFile);
} catch (error) {
  console.error(`配置文件有问题：${(error as Error).message}`);
  process.exit(1);
}
const log = (line: string) => console.log(`${new Date().toISOString()} [insoulforge-activity] ${line}`);
let stop = new AbortController();
let shuttingDown = false;
let reload = false;
const finish = () => {
  shuttingDown = true;
  stop.abort();
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
process.on("uncaughtException", (error) => log(`stray error: ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => log(`stray rejection: ${(error as Error)?.stack ?? error}`));

const service = createService(config, hubClient(config), log);
log(`配置：${configFile}`);

// A config edit takes effect without a restart. A valid file replaces projects and allowlists; reconnecting makes
// InSoulForge cache the new registration text, which is where the model reads the project list. A broken file is
// reported and the old registration keeps serving, just as rules.json keeps its old rules.
let timer: NodeJS.Timeout | undefined;
const watcher = watch(dirname(configFile), (_event, file) => {
  if (file && String(file) !== basename(configFile)) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const next = readConfig(configFile);
      service.update(next);
      config = next;
      log(`配置已更新：${Object.keys(next.projects).join("、")}`);
      reload = true;
      stop.abort();
    } catch (error) {
      log(`配置没有更新，继续用旧配置：${(error as Error).message}`);
    }
  }, 100);
});

try {
  while (!shuttingDown) {
    const current = stop;
    await serve(config, service, log, current.signal);
    if (shuttingDown) break;
    if (!reload) {
      log("Activity 服务意外停止，重新启动");
    }
    reload = false;
    stop = new AbortController();
    log("按新配置重新连接");
  }
} finally {
  watcher.close();
  clearTimeout(timer);
}
