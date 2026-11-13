// GitHub comments longer than the summary are lost when the event detail carries the old issue body instead of the comment.
// A policy needs the sender's login; prose or an invalid identity must not become an actor.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import github from "../plugins/github/source.ts";

const secret = "test-secret";

test("github: an issue comment carries its full words and the issue as its subject", () => {
  const comment = `${"A".repeat(200)}keep the rest of this comment`;
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "example/widgets" },
    issue: {
      number: 42,
      title: "Original issue",
      body: "The old issue body",
      html_url: "https://github.com/example/widgets/issues/42",
    },
    comment: {
      body: comment,
      html_url: "https://github.com/example/widgets/issues/42#issuecomment-1",
    },
    sender: { login: "alice" },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const [event] = github({
    headers: {
      "x-hub-signature-256": signature,
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-1",
    },
    body,
    secret,
  });

  assert.equal(event.type, "issue_comment.created");
  assert.equal(event.subject, "example/widgets#42");
  assert.equal(event.summary, comment.slice(0, 200));
  assert.equal(event.detail, comment);
  assert.equal(event.link, "https://github.com/example/widgets/issues/42#issuecomment-1");
  assert.equal(event.actor, "alice");
});

test("github: a sender login with spaces or prose becomes an empty actor", () => {
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: "example/widgets" },
    issue: { number: 1, title: "x", html_url: "https://github.com/example/widgets/issues/1" },
    sender: { login: "alice said hi" },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const [event] = github({
    headers: { "x-hub-signature-256": signature, "x-github-event": "issues", "x-github-delivery": "d-2" },
    body,
    secret,
  });
  assert.equal(event.actor, "");
});
