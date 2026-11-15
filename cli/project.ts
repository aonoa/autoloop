// Project management for the InSoulForge bridge: one command keeps the hub's rules and the Activity's project list in
// step. The Activity watches its own config, so a successful write takes effect without restarting either service.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseRules } from "../protocol/rules.ts";
import { RULES_FILE } from "../host/home.ts";

type Flags = Record<string, string | true>;
type Project = { description: string; rule: string };
type Activity = { projects?: Record<string, Project>; allow?: { private?: string[]; groups?: string[] } };

const ID = /^[A-Za-z0-9._-]{1,40}$/;
const QQ_TYPES = ["qq.task", "card.answered"];
const DEFAULT_PARALLEL = 4;

const USAGE = `用法：agent-autoloop project <add|list|remove> [参数]

  add <项目短名> --description <说明> [--worker <节点>] [--cwd <目录>] [--agent <Agent>] [--rule <规则名>]
                 [--activity-config <文件>] [--subjects <对象1,对象2>] [--no-resume]
  list [--json] [--activity-config <文件>]
  remove <项目短名> [--activity-config <文件>]

项目短名只能用字母、数字和 . _ -。--worker 选择该节点上的 Agent；写 --agent 时，
它必须就在这个节点上。不写 --worker 时沿用现有 Agent。add 会同时更新 rules.json 和 Activity 配置；
Activity 配置默认取 AGENT_AUTOLOOP_ACTIVITY_CONFIG、INSOULFORGE_ACTIVITY_CONFIG，
再找 ~/.insoulforge/activity.json。配置合法变更会自动生效，不需要重启。`;

function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}

const text = (value: string | true | undefined) => (typeof value === "string" ? value.trim() : undefined);

function readJson(file: string, what: string): any {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${what} 读不出来：${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} 必须是 JSON 对象`);
  return value;
}

function activityFile(named: Flags) {
  const given = text(named["activity-config"]);
  if (given) return path.resolve(given);
  const env = process.env.AGENT_AUTOLOOP_ACTIVITY_CONFIG ?? process.env.INSOULFORGE_ACTIVITY_CONFIG;
  if (env) return path.resolve(env);
  const conventional = path.join(homedir(), ".insoulforge", "activity.json");
  return existsSync(conventional) ? conventional : undefined;
}

function readActivity(file: string | undefined): { file?: string; data?: Activity; text?: string } {
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`找不到 Activity 配置：${file}`);
  const data = readJson(file, "Activity 配置");
  if (
    data.projects !== undefined &&
    (!data.projects || typeof data.projects !== "object" || Array.isArray(data.projects))
  )
    throw new Error("Activity 配置的 projects 要是一个对象");
  for (const [id, project] of Object.entries<any>(data.projects ?? {})) {
    if (!ID.test(id)) throw new Error(`Activity 配置里的项目短名不正确：${id}`);
    if (!project || typeof project.description !== "string" || typeof project.rule !== "string" || !project.rule)
      throw new Error(`Activity 配置里的项目 ${id} 要写 description 和 rule`);
  }
  return { file, data, text: readFileSync(file, "utf8") };
}

function readRules() {
  if (!existsSync(RULES_FILE)) throw new Error(`找不到规则文件：${RULES_FILE}`);
  const text = readFileSync(RULES_FILE, "utf8");
  const data = readJson(RULES_FILE, "规则文件");
  if (!Array.isArray(data.rules)) throw new Error("规则文件里的 rules 要是一个列表");
  return { file: RULES_FILE, text, data };
}

function checkRules(data: any) {
  parseRules(JSON.stringify(data), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function atomicWrite(file: string, value: string) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
}

function projectIds(activity: Activity | undefined, rules: any) {
  const ids = new Set<string>();
  for (const id of Object.keys(activity?.projects ?? {})) ids.add(id);
  for (const rule of rules.rules ?? []) if (typeof rule.project === "string") ids.add(rule.project);
  return [...ids].sort();
}

function ruleOf(rules: any, project: string, name?: string) {
  return (
    rules.rules.find((rule: any) => rule.name === name) ?? rules.rules.find((rule: any) => rule.project === project)
  );
}

function agentsOn(rules: any, worker: string) {
  return Object.entries<any>(rules.agents ?? {})
    .filter(([, agent]) => agent?.worker === worker)
    .map(([id]) => id);
}

function workerOf(rules: any, agent: string | undefined) {
  return agent ? (rules.agents?.[agent]?.worker ?? "") : "";
}

/** A project's node comes from its agent: the worker is the only thing that decides who can claim a run. */
function chooseAgent(rules: any, named: Flags, existingRule: any, project: string) {
  const worker = text(named.worker);
  const namedAgent = text(named.agent);
  const agent = namedAgent ?? existingRule?.to ?? ruleOf(rules, "general")?.to ?? Object.keys(rules.agents ?? {})[0];
  if (!agent || !Object.hasOwn(rules.agents ?? {}, agent))
    throw new Error(`规则文件里没有 Agent：${agent ?? "（没有）"}`);
  const on = workerOf(rules, agent);
  if (!worker) return { agent, worker: on };
  const candidates = agentsOn(rules, worker);
  if (!candidates.length) {
    const workers = [
      ...new Set(
        Object.values<any>(rules.agents ?? {})
          .map((one) => one?.worker)
          .filter(Boolean),
      ),
    ];
    throw new Error(`没有节点 ${worker}；现有节点：${workers.join("、") || "（没有）"}`);
  }
  if (namedAgent && on !== worker)
    throw new Error(`Agent ${agent} 在节点 ${on || "（未指定）"}，不在 ${worker}；可改用 ${candidates.join("、")}`);
  if (namedAgent) return { agent, worker };
  if (on === worker) return { agent, worker };
  // Switching an existing project to another node must pick an agent there, not keep a rule that would run elsewhere.
  if (existingRule)
    throw new Error(
      `项目 ${project} 现在用 Agent ${agent}（节点 ${on || "（未指定）"}）；换到 ${worker} 要同时写 --agent，可选 ${candidates.join("、")}`,
    );
  return { agent: candidates[0], worker };
}

function chats(activity: Activity | undefined) {
  const privateIds = activity?.allow?.private;
  const groups = activity?.allow?.groups;
  const valid = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((one) => typeof one === "string" && /^[1-9][0-9]*$/.test(one));
  if (privateIds !== undefined && !valid(privateIds)) throw new Error("Activity 配置的 allow.private 必须是 QQ 号数组");
  if (groups !== undefined && !valid(groups)) throw new Error("Activity 配置的 allow.groups 必须是群号数组");
  return { private: privateIds ?? [], groups: groups ?? [] };
}

function subjectsFor(project: string, activity: Activity | undefined) {
  const { private: privateIds, groups } = chats(activity);
  return [
    ...privateIds.map((id) => `qq-private-${id}/${project}*`),
    ...groups.map((id) => `qq-group-${id}/${project}*`),
  ];
}

function checkActivity(data: Activity) {
  if (!data.projects || typeof data.projects !== "object" || Array.isArray(data.projects))
    throw new Error("Activity 配置的 projects 要是一个对象");
  for (const [id, project] of Object.entries<any>(data.projects)) {
    if (!ID.test(id)) throw new Error(`Activity 配置里的项目短名不正确：${id}`);
    if (!project || typeof project.description !== "string" || typeof project.rule !== "string" || !project.rule)
      throw new Error(`Activity 配置里的项目 ${id} 要写 description 和 rule`);
  }
  chats(data);
}

function defaultPrompt(project: string) {
  return `这是通过 QQ（经机器人）交代给 ${project} 项目的任务。只处理这一个项目，不要改其他仓库。先读当前工作区和必要文档，再按消息内容处理；工作区有未提交改动时不要覆盖它们，也不要提交或推送，除非消息明确要求。需要拍板时用 ask 卡片提问；完成后用一句话汇报结果，并附上实际改动或验证情况。不要声称没有验证过的结果。`;
}

function writeBoth(
  rules: ReturnType<typeof readRules>,
  activity: ReturnType<typeof readActivity>,
  nextRules: any,
  nextActivity?: Activity,
) {
  checkRules(nextRules);
  const rulesText = `${JSON.stringify(nextRules, null, 2)}\n`;
  const activityText = nextActivity === undefined ? undefined : `${JSON.stringify(nextActivity, null, 2)}\n`;
  const wrote: { file: string; before: string }[] = [];
  try {
    atomicWrite(rules.file, rulesText);
    wrote.push({ file: rules.file, before: rules.text });
    if (activity.file && activityText !== undefined) {
      atomicWrite(activity.file, activityText);
      wrote.push({ file: activity.file, before: activity.text! });
    }
  } catch (error) {
    for (const one of wrote.reverse()) atomicWrite(one.file, one.before);
    throw error;
  }
}

function add(named: Flags, rest: string[]) {
  const project = rest[0];
  if (!project || rest.length > 1) throw new Error(USAGE);
  if (!ID.test(project)) throw new Error("项目短名只能用字母、数字和 . _ -，最多 40 个字符");
  const description = text(named.description);
  if (!description) throw new Error("add 要写 --description，说明这个项目是做什么的");

  const rules = readRules();
  const activity = readActivity(activityFile(named));
  const existingRule = ruleOf(rules.data, project, text(named.rule));
  const existingProject = activity.data?.projects?.[project];
  if (existingRule && existingRule.project !== project)
    throw new Error(`规则名「${existingRule.name}」已经被项目 ${existingRule.project ?? "（未命名）"} 使用`);
  if (existingRule && text(named.rule) && existingRule.name !== text(named.rule) && existingRule.project === project)
    throw new Error(`项目 ${project} 已有规则「${existingRule.name}」，不要用 --rule 改名；请直接改规则文件`);

  const ruleName = existingRule?.name ?? text(named.rule) ?? `QQ 任务 ${project}`;
  const duplicate = rules.data.rules.find((rule: any) => rule.name === ruleName);
  if (duplicate && duplicate.project !== project)
    throw new Error(`规则名「${ruleName}」已经被项目 ${duplicate.project ?? "（未命名）"} 使用`);

  const source = text(named.source) ?? existingRule?.when?.source ?? "qq";
  if (!Object.hasOwn(rules.data.sources ?? {}, source)) throw new Error(`规则文件里没有来源：${source}`);
  const { agent, worker } = chooseAgent(rules.data, named, existingRule, project);
  const cwd = text(named.cwd) ?? existingRule?.cwd ?? `~/${project}`;
  const explicitSubjects = text(named.subjects);
  const subjects = explicitSubjects
    ? explicitSubjects
        .split(",")
        .map((one) => one.trim())
        .filter(Boolean)
    : (existingRule?.when?.subjects ?? subjectsFor(project, activity.data));
  if (!subjects.length)
    throw new Error("Activity 配置里没有 allow.private 或 allow.groups；用 --subjects 写规则要匹配的 subject");
  const channels =
    existingRule?.channels ?? (Object.hasOwn(rules.data.channels ?? {}, "insoulforge") ? ["insoulforge"] : undefined);
  const next = existingRule
    ? {
        ...existingRule,
        when: {
          ...existingRule.when,
          source,
          types: existingRule.when?.types ?? QQ_TYPES,
          subjects,
        },
        to: agent,
        project,
        cwd,
      }
    : {
        name: ruleName,
        when: { source, types: QQ_TYPES, subjects },
        to: agent,
        project,
        cwd,
        prompt: defaultPrompt(project),
        tell: "always",
        parallel: DEFAULT_PARALLEL,
        ...(named["no-resume"] === undefined && { resume: true }),
        ...(channels && { channels }),
      };
  const nextRules = {
    ...rules.data,
    rules: existingRule
      ? rules.data.rules.map((rule: any) => (rule === existingRule ? next : rule))
      : [...rules.data.rules, next],
  };
  const nextActivity = activity.data
    ? {
        ...activity.data,
        projects: { ...(activity.data.projects ?? {}), [project]: { description, rule: ruleName } },
      }
    : undefined;
  if (nextActivity) checkActivity(nextActivity);
  writeBoth(rules, activity, nextRules, nextActivity);
  const where = activity.file ? `，Activity 配置 ${activity.file}` : "；没有找到 Activity 配置，只更新了 rules.json";
  console.log(
    `${existingProject || existingRule ? "更新" : "添加"}了项目 ${project}：规则「${ruleName}」，目录 ${cwd}，Agent ${agent}，节点 ${worker || "（未指定）"}${where}。`,
  );
  if (!activity.file) console.log("用 --activity-config 指向 Activity 配置，才能让 QQ 机器人看到这个项目。");
}

function list(named: Flags) {
  const rules = readRules();
  const activity = readActivity(activityFile(named));
  const ids = projectIds(activity.data, rules.data);
  const rows = ids.map((id) => {
    const project = activity.data?.projects?.[id];
    const rule = ruleOf(rules.data, id, project?.rule);
    return {
      project: id,
      description: project?.description ?? "",
      rule: project?.rule ?? rule?.name ?? "",
      cwd: rule?.cwd ?? "",
      agent: rule?.to ?? "",
      worker: workerOf(rules.data, rule?.to),
      source: rule?.when?.source ?? "",
      subjects: rule?.when?.subjects ?? [],
    };
  });
  if (named.json !== undefined) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log("还没有项目。");
  for (const row of rows)
    console.log(
      `${row.project}\t${row.description || "（无说明）"}\t规则：${row.rule || "（未绑定）"}\t${row.cwd}\tAgent：${row.agent || "（无）"}\t节点：${row.worker || "（未指定）"}`,
    );
}

function remove(named: Flags, rest: string[]) {
  const project = rest[0];
  if (!project || rest.length > 1) throw new Error(USAGE);
  const rules = readRules();
  const activity = readActivity(activityFile(named));
  const entry = activity.data?.projects?.[project];
  const candidates = rules.data.rules.filter((rule: any) => rule.project === project);
  if (!entry && !candidates.length) throw new Error(`没有项目：${project}`);
  if (entry?.rule === "QQ 通用任务" || project === "general")
    throw new Error("general 是通用任务入口，不能从项目命令里删除；确实要删请直接改规则文件");
  const names = new Set(candidates.map((rule: any) => rule.name));
  const nextRules = { ...rules.data, rules: rules.data.rules.filter((rule: any) => !names.has(rule.name)) };
  let nextActivity: Activity | undefined;
  if (activity.data) {
    const projects = { ...(activity.data.projects ?? {}) };
    delete projects[project];
    nextActivity = { ...activity.data, projects };
  }
  if (nextActivity) checkActivity(nextActivity);
  writeBoth(rules, activity, nextRules, nextActivity);
  console.log(
    `删除了项目 ${project}${names.size ? ` 和规则 ${[...names].map((name) => `「${name}」`).join("、")}` : ""}。`,
  );
}

export function projectCommand(args: string[]) {
  const { named, rest } = flags(args);
  if (args.includes("--help") || args.includes("-h")) return console.log(USAGE);
  const action = rest.shift();
  if (action === "add") return add(named, rest);
  if (action === "list") return list(named);
  if (action === "remove") return remove(named, rest);
  throw new Error(USAGE);
}
