// Codex: the user's own, installed and signed in by them. A run is a `codex exec` in the background; its thread is kept
// on disk, so a retry or an answer can go on in it, and the link opens it in the app.
import { execFileSync } from "node:child_process";
import { commandLine, powershell, psQuote } from "../../host/command.ts";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
/** A step is a line a person can scan, not a transcript: collapse whitespace and cut long output. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);
export const IN_THE_APP = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

export default {
  command: (turn) => {
    // The elevated Windows sandbox runs as CodexSandboxUsers. Share only the supplied data, never the run token or key.
    if (process.platform === "win32" && turn.contextFile)
      powershell(`
      try { $sid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]) }
      catch [Security.Principal.IdentityNotMappedException] { return }
      $file = ${psQuote(turn.contextFile)}
      $acl = [IO.File]::GetAccessControl($file)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
      [IO.File]::SetAccessControl($file, $acl)
    `);
    return [
      turn.program ?? findProgram("codex", () => IN_THE_APP),
      "exec",
      ...(turn.resume ? ["resume"] : []),
      "--json",
      "--skip-git-repo-check",
      ...(turn.model ? ["-m", turn.model] : []),
      ...(turn.effort ? ["-c", `model_reasoning_effort="${turn.effort}"`] : []),
      // Unset, a run takes the tier in ~/.codex/config.toml, a file the Codex app shares: "priority" is its Fast.
      ...(turn.tier ? ["-c", `service_tier="${turn.tier}"`] : []),
      // As config, because `codex exec resume` takes no -s.
      "-c",
      `sandbox_mode="${SANDBOX[turn.access]}"`,
      "-c",
      'approval_policy="never"',
      ...(turn.resume ? [turn.resume] : []),
      "本轮通过后台 codex exec 运行，不要假定桌面应用的浏览器连接已带到本轮。" +
        "网页操作使用本轮实际可用的浏览器工具，或使用规则或 Skill 中已明确配置的浏览器入口。" +
        "沿用该入口的会话，只交网页步骤，业务处理和中台回执仍由本轮负责；没有可用入口或需要本人恢复连接时，按待你处理的约定交回。\n\n" +
        turn.prompt,
    ];
  },
  read(stdout, code, stderr) {
    const seen: {
      text?: string;
      session?: string;
      sessionUsage?: object;
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
      progress?: { step: string; detail?: string; kind?: string }[];
    } = {};
    seen.progress = [];
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event) continue;
      if (event.type === "thread.started") seen.session = event.thread_id;
      else if (event.type === "turn.started") seen.started = true;
      else if (event.type === "item.started" && event.item?.type === "command_execution" && event.item.command) {
        seen.progress.push({
          kind: "command",
          step: `执行命令：${oneLine(event.item.command)}`,
        });
      } else if (event.type === "item.completed" && event.item?.type === "command_execution") {
        const command = oneLine(event.item.command ?? "");
        const failed = event.item.exit_code !== undefined && event.item.exit_code !== 0;
        seen.progress.push({
          kind: "command-done",
          step: `${failed ? "命令失败" : "命令完成"}${command ? `：${command}` : ""}`,
        });
      } else if (event.type === "item.completed" && event.item?.type === "reasoning" && event.item.text) {
        seen.progress.push({ kind: "thinking", step: `思考：${oneLine(event.item.text)}` });
      } else if (event.type === "item.completed" && event.item?.type === "file_change" && event.item.changes) {
        const paths = event.item.changes
          .map((change: any) => change.path)
          .filter(Boolean)
          .slice(0, 4);
        seen.progress.push({
          kind: "file",
          step: `修改文件${paths.length ? `：${paths.join("、")}` : ""}`,
        });
      } else if (event.type === "item.started" && event.item?.type === "mcp_tool_call" && event.item.tool) {
        seen.progress.push({ kind: "tool", step: `调用工具：${event.item.tool}` });
      } else if (event.type === "item.completed" && event.item?.type === "web_search" && event.item.query) {
        seen.progress.push({ kind: "search", step: `搜索：${oneLine(event.item.query)}` });
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") seen.text = event.item.text;
      else if (event.type === "turn.completed") {
        seen.completed = seen.finished = true;
        // A reconnect is announced as an error event and then got over — it fell back to another transport and carried
        // on — so it isn't how the turn ended. A finished run was redone twelve times over one of these.
        delete seen.error;
        const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0 } = event.usage ?? {};
        seen.sessionUsage = { input: input_tokens, output: output_tokens, cached: cached_input_tokens };
      } else if (event.type === "turn.failed") {
        seen.finished = true;
        seen.error = event.error?.message || "Codex 没跑完这一轮";
      } else if (event.type === "error") seen.error = event.message;
    }
    const { completed, ...reading } = seen;
    if (!reading.progress?.length) delete reading.progress;
    // Only a finished turn's last message is its answer; before that it's only as far as it had got.
    if (!completed) delete reading.text;
    if (code !== null && !completed && !reading.error) reading.error = tail(stderr) || "Codex 没有完成并留下实际结果";
    if (completed && !reading.text?.trim()) reading.error = "Codex 没有完成并留下实际结果";
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
  check(program) {
    try {
      execFileSync(...commandLine([program ?? findProgram("codex", () => IN_THE_APP), "login", "status"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `Codex 没有登录或用不了：运行 codex login（${(error as Error).message.split("\n")[0]}）`;
    }
  },
} satisfies Adapter;
