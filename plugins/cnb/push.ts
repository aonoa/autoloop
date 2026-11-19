// Run from a CNB pipeline: it forwards the build's own event to the hub, signed, so a repository needs no public
// webhook settings. The token travels in the container's environment, never on the command line or in the log.
//
//   .cnb.yml (on the events you care about; push.ts and core.ts live in this repository):
//     env:
//       AUTOLOOP_URL: https://你的中台地址
//     imports:
//       - https://cnb.cool/你的/密钥仓库/-/blob/main/autoloop.yml   # AUTOLOOP_CNB_SECRET: …
//     $:
//       issue.open:
//         - stages:
//             - script: node .cnb/autoloop/push.ts
//
// The build already has CNB_REPO_SLUG, CNB_EVENT, CNB_EVENT_URL and the event's own CNB_* variables; the script reads
// them rather than asking the API for something the pipeline already knows.
import { createHmac } from "node:crypto";
import { pipelineEvent } from "./core.ts";

const env = process.env;
const hub = (env.AUTOLOOP_URL ?? "").replace(/\/$/, "");
const secret = env.AUTOLOOP_CNB_SECRET ?? "";
if (!hub) throw new Error("缺少 AUTOLOOP_URL：填中台的地址（到端口，不带 /v1/in）");
if (!secret) throw new Error("缺少 AUTOLOOP_CNB_SECRET：和 AGENT_AUTOLOOP_SECRET_CNB 相同");

const number = (value: string | undefined) => (/^[0-9]+$/.test(value ?? "") ? value! : "");
// The pipeline already holds the issue or comment this run is about; ask the API for nothing it already knows. A comment
// sets CNB_COMMENT_BODY, so it is what the Agent should read instead of the older issue body it hangs on.
const issue = number(env.CNB_ISSUE_IID)
  ? {
      number: number(env.CNB_ISSUE_IID),
      title: env.CNB_ISSUE_TITLE,
      body: env.CNB_COMMENT_BODY || env.CNB_ISSUE_DESCRIPTION,
      html_url: env.CNB_EVENT_URL,
    }
  : undefined;
const pullRequest = number(env.CNB_PULL_REQUEST_IID)
  ? {
      number: number(env.CNB_PULL_REQUEST_IID),
      title: env.CNB_PULL_REQUEST_TITLE,
      body: env.CNB_COMMENT_BODY || env.CNB_PULL_REQUEST_DESCRIPTION,
      html_url: env.CNB_EVENT_URL,
    }
  : undefined;
// CNB_EVENT is the event that set this pipeline off (`issue.comment`, `pull_request.merged`, …). Reading it beats
// guessing from CNB_COMMENT_BODY: pull_request.comment also sets that variable, and guessing filed PR comments as issues.
// A PR carries both code comments and ordinary ones under one pipeline event; CNB_COMMENT_TYPE says which this is.
const eventName =
  env.CNB_EVENT === "pull_request.comment"
    ? env.CNB_COMMENT_TYPE === "diff_note"
      ? "pull_request_review_comment.created"
      : "issue_comment.created"
    : (env.CNB_EVENT ?? "");
// The platform's own object id keeps one event one key, so a retried pipeline is recorded once. The pipeline id is the
// fallback for events with no object of their own, such as a push.
const eventKey =
  env.CNB_COMMENT_ID || env.CNB_ISSUE_ID || env.CNB_PULL_REQUEST_ID || env.CNB_PIPELINE_ID || env.CNB_COMMIT || "";
const id = `pipeline-${eventName}-${eventKey}`;

const event = pipelineEvent({
  repo: env.CNB_REPO_SLUG ?? "",
  event: eventName,
  id,
  actor: env.CNB_BUILD_USER ?? "",
  url: env.CNB_EVENT_URL ?? "",
  title: env.CNB_COMMIT_MESSAGE_TITLE ?? "",
  issue,
  pullRequest,
});
if (!event) throw new Error("这条流水线的事件没法变成中台认识的事件：检查 CNB_REPO_SLUG 和 CNB_EVENT");

// Send what the build knows, not what this script made of it: the hub's adapter does the translation, so the two ends
// can't drift apart.
const body = JSON.stringify({
  events: [
    {
      repo: env.CNB_REPO_SLUG ?? "",
      event: eventName,
      id,
      actor: env.CNB_BUILD_USER ?? "",
      url: env.CNB_EVENT_URL ?? "",
      title: env.CNB_COMMIT_MESSAGE_TITLE ?? "",
      issue,
      pullRequest,
    },
  ],
});
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const response = await fetch(`${hub}/v1/in/cnb`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-cnb-signature-256": signature },
  body,
});
const said = await response.text();
if (!response.ok) throw new Error(`中台没收：${response.status} ${said}`);
console.log(`已转交 ${event.type} ${event.subject}`);
