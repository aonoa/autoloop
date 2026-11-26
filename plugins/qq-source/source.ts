// A long-running QQ message source, run beside the hub: it connects to NapCat's forward WebSocket, accepts allowlisted
// private messages and messages from allowlisted groups, and posts each as one `qq.task` event. It is not the webhook
// `source.ts` contract, which must be synchronous; this file exports the bridge that `up` starts as a channel.
//   config.json: "channels": { "qq": { "use": "qq-source", "key": "…", "url": "http://127.0.0.1:3350",
//                                   "ws": "ws://127.0.0.1:3000", "token": "…",
//                                   "sourceKey": "…", "allowed": ["10001"], "groups": ["20002"],
//                                   "bot": "1517455220" } }
// The channel key is only for the channel's own connection; the source key is what posts events. A source key never goes
// into an Agent's environment.
import { createBridge } from "./bridge.ts";

type Options = {
  url?: string;
  ws?: string;
  token?: string;
  sourceKey?: string;
  allowed?: string[];
  groups?: string[];
  bot?: string;
};

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export default async function qqSource({
  options,
  log,
  signal,
}: {
  options: Options;
  log: (line: string) => void;
  signal: AbortSignal;
}) {
  const url = String(options.url ?? "");
  const ws = String(options.ws ?? "");
  const sourceKey = String(options.sourceKey ?? "");
  if (!url) throw new Error("qq-source 要在 config.json 写 url（中台地址）");
  if (!ws) throw new Error("qq-source 要在 config.json 写 ws（NapCat 正向 WebSocket 地址）");
  if (!sourceKey) throw new Error("qq-source 要在 config.json 写 sourceKey（来源密钥）");
  if (!Array.isArray(options.allowed) || !options.allowed.length) {
    throw new Error("qq-source 要在 config.json 写 allowed：允许派任务的 QQ 号，不能为空");
  }
  const bridge = createBridge({ url, key: sourceKey, options, log, signal });

  let handling = Promise.resolve();
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const target = new URL(ws);
      if (options.token) target.searchParams.set("access_token", String(options.token));
      const socket = new WebSocket(target);
      let closed = false;
      const stop = () => {
        if (!closed) socket.close();
      };
      signal.addEventListener("abort", stop, { once: true });
      socket.addEventListener("open", () => log("已连上 NapCat，等待私聊或群任务"));
      socket.addEventListener("message", (event) => {
        let payload: any;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          log("NapCat 发来一段读不懂的数据");
          return;
        }
        handling = handling
          .then(async () => {
            await bridge.accept(payload);
          })
          .catch((error) => log(`任务没处理：${error}`));
      });
      socket.addEventListener("error", (event) => {
        if (!signal.aborted) log(`NapCat WebSocket：${(event as any)?.message ?? "连接出错"}`);
      });
      socket.addEventListener("close", () => {
        closed = true;
        signal.removeEventListener("abort", stop);
        resolve();
      });
    });
    if (!signal.aborted) {
      log("NapCat WebSocket 断开了，5 秒后重连");
      await pause(5_000, signal);
    }
  }
  await handling;
}
