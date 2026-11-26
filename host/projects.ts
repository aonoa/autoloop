// Project registration for the hub itself: one place reads and validates both the rules and the optional Activity
// project list, and writes them together. The CLI and the owner-only HTTP door share it; no model and no plugin gets to
// edit either file directly.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseRules } from "../protocol/rules.ts";
import { RULES_FILE } from "./home.ts";

export type Project = { description: string; rule: string };
export type Activity = { projects?: Record<string, Project>; allow?: { private?: string[]; groups?: string[] } };
export type ProjectInput = {
  project: string;
  description: string;
  worker?: string;
  cwd?: string;
  agent?: string;
  rule?: string;
  subjects?: string[];
  types?: string[];
  resume?: boolean;
  source?: string;
  activityConfig?: string;
};

const ID = /^[A-Za-z0-9._-]{1,40}$/;
const QQ_TYPES = ["qq.task", "card.answered"];
const DEFAULT_PARALLEL = 4;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export function projectId(value: unknown) {
  const id = text(value);
  if (!id || !ID.test(id)) throw new Error("项目短名只能用字母、数字和 . _ -，最多 40 个字符");
  return id;
}

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

export function activityFile(given?: string) {
  if (given) return path.resolve(given);
  const env = process.env.AGENT_AUTOLOOP_ACTIVITY_CONFIG ?? process.env.INSOULFORGE_ACTIVITY_CONFIG;
  if (env) return path.resolve(env);
  const conventional = path.join(homedir(), ".insoulforge", "activity.json");
  return existsSync(conventional) ? conventional : undefined;
}

export function readActivity(file: string | undefined): { file?: string; data?: Activity; text?: string } {
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

export function readRules(file = RULES_FILE) {
  if (!existsSync(file)) throw new Error(`找不到规则文件：${file}`);
  const text = readFileSync(file, "utf8");
  const data = readJson(file, "规则文件");
  if (!Array.isArray(data.rules)) throw new Error("规则文件里的 rules 要是一个列表");
  return { file, text, data };
}

function checkRules(data: any) {
  parseRules(JSON.stringify(data), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function atomicWrite(file: string, value: string) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
}

export function projectIds(activity: Activity | undefined, rules: any) {
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

export function workerOf(rules: any, agent: string | undefined) {
  return agent ? (rules.agents?.[agent]?.worker ?? "") : "";
}

function chooseAgent(rules: any, input: ProjectInput, existingRule: any, project: string) {
  const worker = text(input.worker);
  const namedAgent = text(input.agent);
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

function defaultPrompt(project: string, source: string) {
  const via = source === "qq" ? "通过 QQ（经机器人）" : `由来源 ${source} `;
  return `这是${via}交代给 ${project} 项目的任务。只处理这一个项目，不要改其他仓库。先读当前工作区和必要文档，再按消息内容处理；工作区有未提交改动时不要覆盖它们，也不要提交或推送，除非消息明确要求。需要拍板时用 ask 卡片提问；完成后用一句话汇报结果，并附上实际改动或验证情况。不要声称没有验证过的结果。`;
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

/** The shape a caller may send over HTTP: no paths beyond what a project registration needs, and no extra keys. */
export function validateProject(input: unknown): ProjectInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("项目要是一个对象");
  const value = input as Record<string, unknown>;
  const known = new Set([
    "project",
    "description",
    "worker",
    "cwd",
    "agent",
    "rule",
    "subjects",
    "types",
    "resume",
    "source",
    "activityConfig",
  ]);
  for (const name of Object.keys(value)) if (!known.has(name)) throw new Error(`不认识的字段：${name}`);
  const project = projectId(value.project);
  const description = text(value.description);
  if (!description) throw new Error("添加项目要写说明，说明这个项目是做什么的");
  for (const name of ["worker", "cwd", "agent", "rule", "source", "activityConfig"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "string") throw new Error(`${name} 要是文字`);
  }
  if (value.resume !== undefined && typeof value.resume !== "boolean") throw new Error("resume 要是 true 或 false");
  if (value.subjects !== undefined) {
    if (!Array.isArray(value.subjects) || !value.subjects.every((one) => typeof one === "string"))
      throw new Error("subjects 要是文字数组");
    if (value.subjects.length > 100) throw new Error("subjects 最多 100 条");
    for (const subject of value.subjects)
      if (!subject.trim() || [...subject].length > 300) throw new Error("subjects 每一条都要非空且最多 300 字");
  }
  if (value.types !== undefined) {
    if (!Array.isArray(value.types) || !value.types.length || !value.types.every((one) => typeof one === "string"))
      throw new Error("types 要是非空的事件类型数组");
    if (value.types.length > 100) throw new Error("types 最多 100 条");
    for (const type of value.types)
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(type) && !/^[a-z][a-z0-9_.-]*\.\*$/.test(type) && type !== "*")
        throw new Error(`types 里的 ${type} 不是有效的事件类型`);
  }
  return {
    project,
    description,
    ...(text(value.worker) && { worker: text(value.worker) }),
    ...(text(value.cwd) && { cwd: text(value.cwd) }),
    ...(text(value.agent) && { agent: text(value.agent) }),
    ...(text(value.rule) && { rule: text(value.rule) }),
    ...(value.subjects && { subjects: value.subjects as string[] }),
    ...(value.types && { types: value.types as string[] }),
    ...(value.resume !== undefined && { resume: value.resume as boolean }),
    ...(text(value.source) && { source: text(value.source) }),
    ...(text(value.activityConfig) && { activityConfig: text(value.activityConfig) }),
  };
}

export type ProjectResult = {
  project: string;
  description: string;
  rule: string;
  cwd: string;
  agent: string;
  worker: string;
  created: boolean;
  activity: string | null;
  subjects: string[];
};

export function addProject(input: ProjectInput, rulesFile = RULES_FILE): ProjectResult {
  validateProject(input);
  const project = projectId(input.project);
  const description = text(input.description)!;
  const rules = readRules(rulesFile);
  const activity = readActivity(activityFile(input.activityConfig));
  const existingRule = ruleOf(rules.data, project, text(input.rule));
  const existingProject = activity.data?.projects?.[project];
  if (existingRule && existingRule.project !== project)
    throw new Error(`规则名「${existingRule.name}」已经被项目 ${existingRule.project ?? "（未命名）"} 使用`);
  if (existingRule && text(input.rule) && existingRule.name !== text(input.rule) && existingRule.project === project)
    throw new Error(`项目 ${project} 已有规则「${existingRule.name}」，不要用 --rule 改名；请直接改规则文件`);

  const source = text(input.source) ?? existingRule?.when?.source ?? "qq";
  if (!Object.hasOwn(rules.data.sources ?? {}, source)) throw new Error(`规则文件里没有来源：${source}`);
  const ruleName = existingRule?.name ?? text(input.rule) ?? `${source === "qq" ? "QQ 任务" : "任务"} ${project}`;
  const duplicate = rules.data.rules.find((rule: any) => rule.name === ruleName);
  if (duplicate && duplicate.project !== project)
    throw new Error(`规则名「${ruleName}」已经被项目 ${duplicate.project ?? "（未命名）"} 使用`);

  const { agent, worker } = chooseAgent(rules.data, input, existingRule, project);
  const cwd = text(input.cwd) ?? existingRule?.cwd ?? `~/${project}`;
  const explicitSubjects = input.subjects?.map((one) => one.trim()).filter(Boolean);
  const types = input.types?.length ? input.types : (existingRule?.when?.types ?? QQ_TYPES);
  const subjects = explicitSubjects?.length
    ? explicitSubjects
    : (existingRule?.when?.subjects ?? subjectsFor(project, activity.data));
  if (!subjects.length)
    throw new Error("Activity 配置里没有 allow.private 或 allow.groups；用 subjects 写规则要匹配的 subject");
  const channels =
    existingRule?.channels ?? (Object.hasOwn(rules.data.channels ?? {}, "insoulforge") ? ["insoulforge"] : undefined);
  const next = existingRule
    ? {
        ...existingRule,
        when: { ...existingRule.when, source, types, subjects },
        to: agent,
        project,
        cwd,
      }
    : {
        name: ruleName,
        when: { source, types, subjects },
        to: agent,
        project,
        cwd,
        prompt: defaultPrompt(project, source),
        tell: "always",
        parallel: DEFAULT_PARALLEL,
        ...(input.resume !== false && { resume: true }),
        ...(channels && { channels }),
      };
  const nextRules = {
    ...rules.data,
    rules: existingRule
      ? rules.data.rules.map((rule: any) => (rule === existingRule ? next : rule))
      : [...rules.data.rules, next],
  };
  const nextActivity = activity.data
    ? { ...activity.data, projects: { ...(activity.data.projects ?? {}), [project]: { description, rule: ruleName } } }
    : undefined;
  if (nextActivity) checkActivity(nextActivity);
  writeBoth(rules, activity, nextRules, nextActivity);
  return {
    project,
    description,
    rule: ruleName,
    cwd,
    agent,
    worker,
    created: !existingProject && !existingRule,
    activity: activity.file ?? null,
    subjects,
  };
}

export function removeProject(projectInput: unknown, rulesFile = RULES_FILE, activityConfig?: string) {
  const project = projectId(projectInput);
  const rules = readRules(rulesFile);
  const activity = readActivity(activityFile(activityConfig));
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
  return { project, rules: [...names] };
}

export function listProjects(rulesFile = RULES_FILE, activityConfig?: string) {
  const rules = readRules(rulesFile);
  const activity = readActivity(activityFile(activityConfig));
  return projectIds(activity.data, rules.data).map((id) => {
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
}
