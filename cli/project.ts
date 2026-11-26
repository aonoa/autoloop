// Project management from the command line. The same core in host/projects.ts is used by the owner-only HTTP door, so
// rules and the optional Activity list are validated and written together wherever the request comes from.
import { addProject, listProjects, projectId, removeProject, type ProjectInput } from "../host/projects.ts";
import { RULES_FILE } from "../host/home.ts";

type Flags = Record<string, string | true>;

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

function inputOf(named: Flags, project: string): ProjectInput {
  return {
    project,
    description: text(named.description) ?? "",
    ...(text(named.worker) && { worker: text(named.worker) }),
    ...(text(named.cwd) && { cwd: text(named.cwd) }),
    ...(text(named.agent) && { agent: text(named.agent) }),
    ...(text(named.rule) && { rule: text(named.rule) }),
    ...(text(named["activity-config"]) && { activityConfig: text(named["activity-config"]) }),
    ...(text(named.subjects) && {
      subjects: text(named.subjects)!
        .split(",")
        .map((one) => one.trim())
        .filter(Boolean),
    }),
    ...(named["no-resume"] !== undefined && { resume: false }),
  };
}

function add(named: Flags, rest: string[]) {
  const project = rest[0];
  if (!project || rest.length > 1) throw new Error(USAGE);
  const result = addProject(inputOf(named, project), RULES_FILE);
  const where = result.activity
    ? `，Activity 配置 ${result.activity}`
    : "；没有找到 Activity 配置，只更新了 rules.json";
  console.log(
    `${result.created ? "添加" : "更新"}了项目 ${result.project}：规则「${result.rule}」，目录 ${result.cwd}，Agent ${result.agent}，节点 ${result.worker || "（未指定）"}${where}。`,
  );
  if (!result.activity) console.log("用 --activity-config 指向 Activity 配置，才能让 QQ 机器人看到这个项目。");
}

function list(named: Flags) {
  const rows = listProjects(RULES_FILE, text(named["activity-config"]));
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
  const result = removeProject(projectId(project), RULES_FILE, text(named["activity-config"]));
  console.log(
    `删除了项目 ${result.project}${result.rules.length ? ` 和规则 ${result.rules.map((name) => `「${name}」`).join("、")}` : ""}。`,
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
