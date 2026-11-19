// CNB as an event source. Failure modes: an event id is a 64-bit integer that JSON.parse rounds, so two pushes share a
// dedupe key and the second is dropped; the stream is one JSON object per line, and reading it as an array silently
// yields no events; CNB reports a merge and a new comment with its own action names (`merged`, `opened`), so a rule
// written in GitHub's words never fires; a push has no number, and inventing one splits the branch's history across
// matters; a comment carries the old issue body instead of the new comment, so the Agent answers the wrong text; the
// poll refetches an issue the same run already read, or dies on one broken line and loses every event; a webhook body
// that isn't signed the way the plugin checks is accepted; a pipeline reads a variable CNB doesn't define, files a PR
// comment as an issue comment, or forwards an event the hub can't match.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import cnb from "../plugins/cnb/source.ts";
import { eventId, eventsOf, pipelineEvent, rows, translate } from "../plugins/cnb/core.ts";
import { poll } from "../plugins/cnb/poll.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const ROOT = join(import.meta.dirname, "..");
const secret = "cnb-secret";

const push = (over: Record<string, unknown> = {}) => ({
  id: 2100000000000000123,
  type: "PushEvent",
  actor: { id: 1816756487609032700, username: "purefox", nickName: "Vantablack" },
  repo: { id: 2113995486814486528, name: "gitcnb/image2api" },
  public: false,
  created_at: "2026-11-11T02:37:12+08:00",
  payload: {
    before: "b095d1a54c8634c714dadddf3bda797dd569aa84",
    head: "d28c17c0b4b1c1fee8729b433e55487efb12b400",
    push_id: "8e9abeac-5402-4d4b-b973-8e6a50b9d261",
    ref: "refs/heads/main",
    distinct_size: 1,
    commits: [{ sha: "d28c17c0", message: "feat: 完善视频协议", author: { name: "purefox" }, distinct: true }],
  },
  ...over,
});

const pull = (over: Record<string, unknown> = {}) => ({
  id: 2122512576248483840,
  type: "PullRequestEvent",
  actor: { id: 1, username: "youkun" },
  repo: { id: 2, name: "cnb/skills/cnb-skill" },
  public: false,
  created_at: "2026-11-17T10:10:07+08:00",
  payload: {
    action: "merged",
    number: 720,
    pull_request: {
      id: 2122354433576636400,
      number: 720,
      state: "PULL_REQUEST_STATE_CLOSED",
      title: "refactor(mcp): 知识库改名",
      body: "改名的说明",
      html_url: "https://cnb.cool/cnb/skills/cnb-skill/-/pulls/720",
      merged_at: "",
      user: { username: "loviselu" },
      head: { ref: "refs/heads/feat/mcp-skill-kb" },
      base: { ref: "refs/heads/main" },
    },
  },
  ...over,
});

test("cnb: a push keeps its repository and no number, and the commit message is what the Agent reads", () => {
  const line = JSON.stringify(push());
  const event = translate(JSON.parse(line), eventId(line))!;
  assert.equal(event.type, "push");
  assert.equal(event.subject, "gitcnb/image2api");
  assert.equal(event.summary, "feat: 完善视频协议");
  assert.equal(event.link, "https://cnb.cool/gitcnb/image2api/-/commit/d28c17c0b4b1c1fee8729b433e55487efb12b400");
  assert.equal(event.actor, "purefox");
});

test("cnb: a 64-bit event id is read as the platform wrote it, so JSON rounding can't merge two events", () => {
  const line = '{"id":2100000000000000123,"type":"PushEvent","repo":{"name":"owner/app"}}';
  const other = '{"id":2100000000000000124,"type":"PushEvent","repo":{"name":"owner/app"}}';
  assert.equal(eventId(line), "2100000000000000123", "the id keeps its digits");
  assert.notEqual(eventId(line), eventId(other), "an event one apart keeps its own key");
  // What JSON.parse does with it, for contrast: both land on the same double.
  assert.equal(JSON.parse(line).id, JSON.parse(other).id);
});

test("cnb: the stream is read line by line, and one broken line doesn't cost the rest", () => {
  const text = `${JSON.stringify(push())}\nnot json\n${JSON.stringify(pull())}\n`;
  const { rows: read, broken } = rows(text);
  assert.equal(read.length, 2);
  assert.equal(broken, true, "a line that can't be read is reported, not swallowed");
  const events = read.map((row) => translate(row, eventId(JSON.stringify(row))));
  assert.deepEqual(
    events.map((event) => event!.type),
    ["push", "pull_request.closed"],
  );
  // The docs show a JSON array; that shape must work too.
  assert.equal(rows(JSON.stringify([push(), pull()])).rows.length, 2);
});

test("cnb: every event of a page arrives once, and its id is the platform's own", () => {
  // Written as text on purpose: JS numbers can't hold these ids, so building the fixture as objects would hide the bug.
  const page = [
    '{"id":2100000000000000123,"type":"PushEvent","repo":{"name":"owner/app"},"payload":{"ref":"refs/heads/main","head":"a","commits":[{"message":"one"}]}}',
    '{"id":2122512576248483840,"type":"PullRequestEvent","repo":{"name":"owner/app"},"payload":{"action":"merged","number":720,"pull_request":{"number":720,"title":"merged","html_url":"https://cnb.cool/owner/app/-/pulls/720"}}}',
    '{"id":2122512576248483841,"type":"PullRequestEvent","repo":{"name":"owner/app"},"payload":{"action":"opened","number":721,"pull_request":{"number":721,"title":"opened","html_url":"https://cnb.cool/owner/app/-/pulls/721"}}}',
  ].join("\n");
  const { events } = eventsOf(page);
  assert.equal(events.length, 3, "three lines are three events, not six");
  assert.deepEqual(
    events.map((event) => event.id),
    ["2100000000000000123", "2122512576248483840", "2122512576248483841"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["push", "pull_request.closed", "pull_request.opened"],
  );
  assert.deepEqual(
    events.map((event) => event.subject),
    ["owner/app", "owner/app#720", "owner/app#721"],
    "neighbours stay apart, and a merge is still the same pull request",
  );
});

test("cnb: a comment is the comment, not the issue body it hangs on", () => {
  const long = `${"A".repeat(200)}keep the rest of this comment`;
  const event = translate(
    {
      id: 9,
      type: "IssueCommentEvent",
      actor: { username: "alice" },
      repo: { name: "owner/app" },
      payload: {
        action: "created",
        issue: { number: 42, title: "原 issue", body: "旧的正文" },
        comment: { body: long, html_url: "https://cnb.cool/owner/app/-/issues/42#comment-1" },
      },
    },
    "9",
  )!;
  assert.equal(event.type, "issue_comment.created");
  assert.equal(event.subject, "owner/app#42");
  assert.equal(event.summary, long.slice(0, 200));
  assert.equal(event.detail, long);
  assert.equal(event.link, "https://cnb.cool/owner/app/-/issues/42#comment-1");
});

test("cnb: an issue event carries the issue's title and body and its own action", () => {
  const event = translate(
    {
      id: 7,
      type: "IssueEvent",
      actor: { username: "bob" },
      repo: { name: "owner/app" },
      payload: { action: "opened", issue: { number: 12, title: "登录页错位", body: "320px 下按钮超框" } },
    },
    "7",
  )!;
  assert.equal(event.type, "issues.opened");
  assert.equal(event.subject, "owner/app#12");
  assert.equal(event.summary, "登录页错位");
  assert.equal(event.detail, "320px 下按钮超框");
});

test("cnb: a comment's real `opened` action is the `created` a GitHub rule matches", () => {
  // What the live stream returns, in contrast with the docs' `created`.
  const event = translate(
    {
      id: 11,
      type: "IssueCommentEvent",
      actor: { username: "alice" },
      repo: { name: "owner/app" },
      payload: {
        action: "opened",
        issue: { number: 42, title: "原 issue" },
        comment: { body: "新的评论", html_url: "https://cnb.cool/owner/app/-/issues/42/comments/1" },
      },
    },
    "11",
  )!;
  assert.equal(event.type, "issue_comment.created");
  const review = translate(
    {
      id: 12,
      type: "PullRequestReviewCommentEvent",
      actor: { username: "alice" },
      repo: { name: "owner/app" },
      payload: {
        action: "opened",
        pull_request: { number: 7, title: "改一下" },
        comment: { body: "这里要改", html_url: "https://cnb.cool/owner/app/-/pulls/7/comments/1" },
      },
    },
    "12",
  )!;
  assert.equal(review.type, "pull_request_review_comment.created");
  assert.equal(review.subject, "owner/app#7");
  assert.equal(review.detail, "这里要改", "a PR comment is not replaced by the PR body");
});

test("cnb: an identity that isn't an identifier becomes no actor at all", () => {
  const event = translate(push({ actor: { username: "pure fox said hi" } }), "1")!;
  assert.equal(event.actor, "");
});

test("cnb: a webhook is taken only when its signature is the one the secret makes", () => {
  const body = JSON.stringify(push());
  const sign = (name: string, text: string) => `sha256=${createHmac("sha256", name).update(text).digest("hex")}`;
  assert.throws(() => cnb({ headers: {}, body, secret }), /signature/);
  assert.throws(() => cnb({ headers: { "x-cnb-signature-256": sign("wrong", body) }, body, secret }), /signature/);
  assert.throws(() => cnb({ headers: { "x-cnb-signature-256": sign(secret, body) }, body, secret: "" }), /signature/);
  const [event] = cnb({ headers: { "x-cnb-signature-256": sign(secret, body) }, body, secret });
  assert.equal(event.type, "push");
  assert.equal(event.subject, "gitcnb/image2api");
});

test("cnb: a pipeline's own variables become the same event a rule already matches", () => {
  const event = pipelineEvent({
    repo: "owner/app",
    event: "issue.open",
    issue: { number: 12, title: "登录页错位", html_url: "https://cnb.cool/owner/app/-/issues/12" },
    actor: "alice",
    id: "pipeline-1",
  })!;
  assert.equal(event.type, "issues.opened");
  assert.equal(event.subject, "owner/app#12");
  assert.equal(event.link, "https://cnb.cool/owner/app/-/issues/12");
  assert.equal(event.actor, "alice");
  assert.equal(pipelineEvent({ event: "issue.open" }), null, "no repository, no event");
});

test("cnb: the pipeline forwarder sends the event CNB names, not a guess from a comment body", async () => {
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ events: [{ routed: [] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // Async: a blocking spawn would hold the event loop this test's own mock server needs to answer.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", join(ROOT, "plugins", "cnb", "push.ts")],
        {
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CNB_"))),
            AUTOLOOP_URL: `http://127.0.0.1:${port}`,
            AUTOLOOP_CNB_SECRET: secret,
            ...env,
          },
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stderr }));
    });
  try {
    const base = {
      CNB_REPO_SLUG: "owner/app",
      CNB_BUILD_USER: "alice",
      CNB_EVENT_URL: "https://cnb.cool/owner/app/-/pulls/7",
    };
    const prComment = await run({
      ...base,
      CNB_EVENT: "pull_request.comment",
      CNB_COMMENT_BODY: "这里要改",
      CNB_COMMENT_ID: "501",
      CNB_COMMENT_TYPE: "note",
      CNB_PULL_REQUEST_IID: "7",
      CNB_PULL_REQUEST_TITLE: "改一下",
      CNB_PULL_REQUEST_DESCRIPTION: "PR 的说明",
      CNB_PIPELINE_ID: "9",
    });
    assert.equal(prComment.status, 0, prComment.stderr);
    const sent = JSON.parse(received[0].body).events[0];
    assert.equal(sent.event, "issue_comment.created", "a PR comment is not an issue comment");
    assert.equal(sent.pullRequest.body, "这里要改");
    assert.equal(sent.id, "pipeline-issue_comment.created-501");
    const sign = `sha256=${createHmac("sha256", secret).update(received[0].body).digest("hex")}`;
    assert.equal(received[0].headers["x-cnb-signature-256"], sign);
    assert.deepEqual(
      cnb({ headers: received[0].headers, body: received[0].body, secret }).map((event) => event.type),
      ["issue_comment.created"],
    );

    const push = await run({
      ...base,
      CNB_EVENT: "push",
      CNB_COMMIT: "abc",
      CNB_COMMIT_MESSAGE_TITLE: "feat: 加接口",
      CNB_PIPELINE_ID: "10",
    });
    assert.equal(push.status, 0, push.stderr);
    const pushed = cnb({ headers: received[1].headers, body: received[1].body, secret })[0];
    assert.equal(
      pushed.summary,
      "feat: 加接口",
      "CNB has no CNB_LATEST_COMMIT_MESSAGE; the title is the real variable",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cnb: what the poll finds goes through the worker whole, and a broken repository doesn't lose the others", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://x");
    if (url.pathname.startsWith("/events/owner/app/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `${JSON.stringify(push({ repo: { name: "owner/app" } }))}\n${JSON.stringify(
          pull({ repo: { name: "owner/app" }, payload: { ...pull().payload, action: "opened" } }),
        )}\n`,
      );
      return;
    }
    if (url.pathname.startsWith("/events/owner/broken/")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    // The issue's full body is only on the issue endpoint; the stream carries the title alone.
    if (url.pathname === "/owner/app/-/issues/12") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ number: "12", title: "登录页错位", body: "完整的正文" }));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const found = await poll(["owner/app", "owner/broken"], {
      api: `http://127.0.0.1:${port}`,
      token: "t",
      hours: 1,
      now: Date.parse("2026-11-18T02:00:00Z"),
    });
    assert.ok(found.events.some((event) => event.type === "pull_request.opened" && event.subject === "owner/app#720"));
    assert.ok(found.events.some((event) => event.type === "push"));
    assert.equal(
      new Set(found.events.map((event) => event.id)).size,
      found.events.length,
      "every event has its own id",
    );
    assert.ok(found.problems.some((problem) => problem.startsWith("owner/broken")));
    assert.ok(!found.problems.some((problem) => problem.startsWith("owner/app")), "an empty hour is not a problem");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cnb: a poll with nothing new reports nothing to do, not an empty event", async () => {
  const server = createServer((_request, response) => response.writeHead(404).end("{}"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const found = await poll(["owner/app"], { api: `http://127.0.0.1:${port}`, token: "t", hours: 1 });
    assert.deepEqual(found.events, []);
    assert.deepEqual(found.problems, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
