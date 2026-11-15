// Failure cases: add leaves the Activity list and rules disagreeing; a project name that cannot become a subject is
// accepted; an existing rule is silently replaced; a bad Activity file is half-written; remove takes the general lane
// or an unrelated rule; list shows a project with no rule as if it were usable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "agent-autoloop.ts");
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-project-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_") && name !== "NODE_TEST_CONTEXT"),
  ) as NodeJS.ProcessEnv;

let homes = 0;
function home() {
  const directory = join(scratch, `home-${++homes}`);
  mkdirSync(directory);
  const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
  rules.sources.qq = { name: "QQ" };
  rules.channels.insoulforge = { name: "QQ 机器人" };
  writeFileSync(join(directory, "rules.json"), JSON.stringify(rules, null, 2));
  writeFileSync(
    join(directory, "activity.json"),
    JSON.stringify(
      {
        allow: { private: ["10001001"], groups: ["20002002"], actor: "10001001", senders: ["10001001"] },
        projects: { general: { description: "通用任务", rule: "QQ 通用任务" } },
      },
      null,
      2,
    ),
  );
  return directory;
}

function run(directory: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "project", ...args], {
    env: {
      ...cleanEnv(),
      AGENT_AUTOLOOP_HOME: directory,
      AGENT_AUTOLOOP_ACTIVITY_CONFIG: join(directory, "activity.json"),
    },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function read(directory: string, file: string) {
  return JSON.parse(readFileSync(join(directory, file), "utf8"));
}

test("add writes the rule and the project list together, with private and group subjects", () => {
  const directory = home();
  const ran = run(directory, [
    "add",
    "shop",
    "--description",
    "商城",
    "--cwd",
    "/srv/shop",
    "--agent",
    "a1",
    "--rule",
    "QQ 任务 shop",
  ]);
  assert.equal(ran.code, 0, ran.stderr);
  const rules = read(directory, "rules.json");
  const rule = rules.rules.find((one: any) => one.name === "QQ 任务 shop");
  assert.equal(rule.project, "shop");
  assert.equal(rule.cwd, "/srv/shop");
  assert.deepEqual(rule.when.subjects, ["qq-private-10001001/shop*", "qq-group-20002002/shop*"]);
  const activity = read(directory, "activity.json");
  assert.deepEqual(activity.projects.shop, { description: "商城", rule: "QQ 任务 shop" });
  assert.deepEqual(activity.projects.general, { description: "通用任务", rule: "QQ 通用任务" });
});

test("add chooses the agent on the named worker, so a project lands on that node", () => {
  const directory = home();
  const ran = run(directory, ["add", "remote", "--description", "远端项目", "--cwd", "/srv/remote", "--worker", "w2"]);
  assert.equal(ran.code, 0, ran.stderr);
  const rule = read(directory, "rules.json").rules.find((one: any) => one.name === "QQ 任务 remote");
  assert.equal(rule.to, "a2");
  assert.match(ran.stdout, /节点 w2/);
});

test("add refuses a worker that has no agent, and refuses an agent on another worker", () => {
  const directory = home();
  const before = [
    readFileSync(join(directory, "rules.json"), "utf8"),
    readFileSync(join(directory, "activity.json"), "utf8"),
  ];
  const missing = run(directory, ["add", "shop", "--description", "商城", "--worker", "nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /没有节点 nope/);
  assert.match(missing.stderr, /w1.*w2|w2.*w1/);

  const conflict = run(directory, ["add", "shop", "--description", "商城", "--worker", "w2", "--agent", "a1"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /Agent a1 在节点 w1/);
  assert.deepEqual(
    [readFileSync(join(directory, "rules.json"), "utf8"), readFileSync(join(directory, "activity.json"), "utf8")],
    before,
  );
});

test("add keeps the existing agent's worker when no worker is named", () => {
  const directory = home();
  assert.equal(run(directory, ["add", "shop", "--description", "商城", "--agent", "a2"]).code, 0);
  const rule = read(directory, "rules.json").rules.find((one: any) => one.project === "shop");
  assert.equal(rule.to, "a2");
  const listed = run(directory, ["list", "--json"]);
  const row = JSON.parse(listed.stdout).find((one: any) => one.project === "shop");
  assert.equal(row.worker, "w2");
});

test("list shows each project's worker, including a project whose rule has no agent", () => {
  const directory = home();
  const rules = read(directory, "rules.json");
  rules.rules.push({ name: "孤儿", when: { cron: "0 1 * * *" }, to: "a1", project: "orphan", cwd: "~/orphan" });
  writeFileSync(join(directory, "rules.json"), JSON.stringify(rules, null, 2));
  const activity = read(directory, "activity.json");
  activity.projects.orphan = { description: "孤儿项目", rule: "孤儿" };
  writeFileSync(join(directory, "activity.json"), JSON.stringify(activity, null, 2));
  const listed = run(directory, ["list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /orphan.*节点：w1/);
});

test("a project name that cannot be a subject is refused without touching either file", () => {
  const directory = home();
  const before = [
    readFileSync(join(directory, "rules.json"), "utf8"),
    readFileSync(join(directory, "activity.json"), "utf8"),
  ];
  const ran = run(directory, ["add", "商城", "--description", "x"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /项目短名/);
  assert.deepEqual(
    [readFileSync(join(directory, "rules.json"), "utf8"), readFileSync(join(directory, "activity.json"), "utf8")],
    before,
  );
});

test("a rule name already used by another project is refused instead of replaced", () => {
  const directory = home();
  const rules = read(directory, "rules.json");
  rules.rules.push({
    name: "共用",
    when: { source: "qq", types: ["qq.task"] },
    to: "a1",
    project: "other",
    cwd: "~/other",
    prompt: "x",
  });
  writeFileSync(join(directory, "rules.json"), JSON.stringify(rules, null, 2));
  const ran = run(directory, ["add", "shop", "--description", "商城", "--rule", "共用"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /已经被项目 other 使用/);
  assert.equal(read(directory, "rules.json").rules.find((one: any) => one.name === "共用").project, "other");
});

test("a broken Activity file is refused and leaves the rules alone", () => {
  const directory = home();
  writeFileSync(join(directory, "activity.json"), "{");
  const before = readFileSync(join(directory, "rules.json"), "utf8");
  const ran = run(directory, ["add", "shop", "--description", "商城"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Activity 配置/);
  assert.equal(readFileSync(join(directory, "rules.json"), "utf8"), before);
});

test("list joins both files, and remove takes the project's rule but not general", () => {
  const directory = home();
  assert.equal(run(directory, ["add", "shop", "--description", "商城"]).code, 0);
  const listed = run(directory, ["list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.deepEqual(
    rows.map((row: any) => [row.project, row.rule]),
    [
      ["general", "QQ 通用任务"],
      ["shop", "QQ 任务 shop"],
    ],
  );
  assert.equal(run(directory, ["remove", "shop"]).code, 0);
  assert.equal(
    read(directory, "rules.json").rules.some((one: any) => one.project === "shop"),
    false,
  );
  assert.equal(read(directory, "activity.json").projects.shop, undefined);
  assert.equal(read(directory, "activity.json").projects.general.rule, "QQ 通用任务");
  const refused = run(directory, ["remove", "general"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /general/);
});
