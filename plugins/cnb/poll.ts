// What happened on CNB, for repositories whose pipelines don't forward events: every hour shard of the repository stream
// is read and turned into the same events a webhook would give. No cursor is kept — an event's id is stable, so the hub
// drops a repeat — and a repository that can't be read is reported without losing the others.
//
//   rules.json:  "sources": { "cnb": { "name": "CNB" } },
//                "agents": { "cnb-watch": { "use": "command", "command": ["node", "/绝对路径/plugins/cnb/poll.ts", "owner/repo"] } }
//                the watch rule writes `emits`; the rule that does the work matches the same source and types.
//   environment: CNB_TOKEN（访问令牌：仓库动态 + Issue 读取）, CNB_API（默认 https://api.cnb.cool）,
//                CNB_HOURS（往回看几个小时，默认 2）, CNB_TZ_OFFSET（分片时区相对 UTC 的分钟，默认 480 即 +08:00）
import { eventsOf, type CnbEvent } from "./core.ts";

type Row = Record<string, any>;
export type Watch = { api?: string; token?: string; hours?: number; offset?: number; now?: number };

const config = (given: Watch) => ({
  api: (given.api ?? process.env.CNB_API ?? "https://api.cnb.cool").replace(/\/$/, ""),
  token: given.token ?? process.env.CNB_TOKEN ?? "",
  hours: Math.max(1, Math.min(24, given.hours ?? (Number(process.env.CNB_HOURS ?? 2) || 2))),
  offset: given.offset ?? (Number(process.env.CNB_TZ_OFFSET ?? 480) || 0),
  now: given.now ?? Date.now(),
});

/** The hour shards to read, oldest first, in the platform's own timezone. */
export function shards(hours: number, offset: number, now: number) {
  const out: string[] = [];
  const pad = (value: number) => String(value).padStart(2, "0");
  for (let back = hours - 1; back >= 0; back--) {
    const at = new Date(now + offset * 60_000 - back * 3_600_000);
    out.push(`${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}`);
  }
  return out;
}

async function get(api: string, token: string, path: string) {
  const response = await fetch(`${api}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path}：${response.status} ${response.statusText}`);
  return response.text();
}

/** A comment or issue event carries no body on the stream; the issue endpoint has it, and the Agent can't open a link. */
async function withIssueBody(
  settings: { api: string; token: string },
  repo: string,
  event: CnbEvent,
): Promise<CnbEvent> {
  if (!/^(issues|issue_comment)\./.test(event.type)) return event;
  const number = /#([0-9]+)$/.exec(event.subject)?.[1];
  if (!number || event.detail) return event;
  try {
    const issue = JSON.parse(await get(settings.api, settings.token, `/${repo}/-/issues/${number}`)) as Row;
    const body = typeof issue.body === "string" ? issue.body : "";
    return body ? { ...event, detail: body.slice(0, 4000) } : event;
  } catch (error) {
    // The stream already gave a title; a missing body is worth less than the event itself.
    console.error(`${repo}#${number} 的正文这次读不到：${(error as Error).message}`);
    return event;
  }
}

/** Every new event of these repositories over the watched hours, and the ones that couldn't be read. */
export async function poll(repos: string[], given: Watch = {}) {
  const { api, token, hours, offset, now } = config(given);
  const settings = { api, token };
  const events: CnbEvent[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const repo of repos) {
    for (const shard of shards(hours, offset, now)) {
      let text = "";
      try {
        text = await get(api, token, `/events/${repo}/-/${shard}`);
      } catch (error) {
        // An hour with no activity answers 404; anything else is worth saying.
        if (!/\b404\b/.test((error as Error).message)) problems.push(`${repo}：${(error as Error).message}`);
        continue;
      }
      for (const found of eventsOf(text).events) {
        if (seen.has(found.id)) continue;
        seen.add(found.id);
        events.push(await withIssueBody(settings, repo, found));
        if (events.length >= 100) break;
      }
      if (events.length >= 100) break;
    }
  }
  return { events, problems };
}

if (import.meta.main) {
  const repos = process.argv.slice(2).filter((name) => !name.startsWith("-"));
  if (!repos.length) throw new Error("请指定至少一个 owner/repo 仓库");
  if (!process.env.CNB_TOKEN) throw new Error("缺少 CNB_TOKEN：访问令牌要能读仓库动态和 Issue（repo-issue:r）");
  const { events, problems } = await poll(repos);
  for (const problem of [...new Set(problems)]) console.error(problem);
  if (!events.length) console.log(`没事可做：${repos.join("、")} 最近没有新动态`);
  else console.log(`看到了 ${events.length} 条新动态\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\``);
}
