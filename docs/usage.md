# 使用指南

本文按日常操作顺序说明如何安装后初始化、跑通一轮、查看状态、回答卡片、暂停和恢复规则，以及排查问题。安装步骤见 [INSTALL.md](../INSTALL.md)，字段见 [configuration.md](configuration.md)。

## 安装后初始化

### 交互安装

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.ps1 | iex
```

安装器会：

- 安装最新 Release 到 `~/.agent-autoloop/app`；
- 创建 `config.json`、`rules.json` 和默认密钥；
- 找到已安装并登录的 Claude Code 或 Codex；
- 安装登录后台服务；
- 把操作手册链接到 `~/.claude/skills` 或 `~/.codex/skills`。

### 非交互安装

CI、容器或临时 HOME：

```bash
AGENT_AUTOLOOP_HOME=/tmp/autoloop sh install.sh --no-service --agent codex --port 3456
```

然后手动启动：

```bash
AGENT_AUTOLOOP_HOME=/tmp/autoloop "$AGENT_AUTOLOOP_HOME/app/bin/agent-autoloop.ts" up
```

`AGENT_AUTOLOOP_HOME` 必须对安装和启动两条命令保持一致。实际路径以安装器打印的完整命令为准。临时 HOME 不要安装系统服务，也不要修改真实用户的 shell 和 Agent 配置。

### 验证

```bash
agent-autoloop doctor
agent-autoloop try
```

`doctor` 检查 Node 版本、规则、服务、中台健康、Agent 登录和通道在线状态。`try` 用真实 Agent 走一遍“发事件 → 执行 → 提问 → 退出 → 回答 → 继续 → 完成”。

## 跑通第一轮

`agent-autoloop try` 会：

1. 发一条 `try.*` 事件；
2. 等 Agent 领取并执行；
3. 等它提问；
4. 在终端显示卡片；
5. 你回答后，等同一事项完成；
6. 打印结果。

交互终端可以直接输入序号；非交互终端：

```bash
agent-autoloop answer 1 2
```

其中第一个 `1` 是卡片编号，第二个 `2` 是选项序号。

如果 `try` 超时，先运行：

```bash
agent-autoloop doctor
agent-autoloop status
```

## 日常查看

### `status`

```bash
agent-autoloop status
```

显示：

- 哪些 Agent 和通道在线；
- 等你回答的卡片；
- 正在执行和排队的轮次；
- 最近几轮和最近的卡片；
- 今天和最近 7 天的轮数、Token、费用；
- 暂停中的规则和跳过的事件。

`status --json` 输出 `/v1/state` 原始结构，适合脚本和看板。

### `board`

```bash
agent-autoloop board
agent-autoloop board --json
```

按事项阶段分组，优先显示需要人的：

- `person/answer`：待回答；
- `person/review`：待审阅；
- `person/blocked`：受阻；
- `person/failed`：失败；
- `person/delivery`：卡片没送到，重试中；
- `working/*` 和 `idle`：不需要立即处理。

### `runs` 和 `why`

```bash
agent-autoloop runs
agent-autoloop runs 处理-issue
agent-autoloop runs --before 120
agent-autoloop why 42
agent-autoloop why 42 --json
```

`runs` 列出已完成的轮次；`why` 显示某一轮的事件、规则版本、领取、执行、回执、卡片和结果。`why --json` 输出原始事实，适合程序处理。

### `decisions` 和 `mandates`

```bash
agent-autoloop decisions
agent-autoloop mandates
```

- `decisions`：最近每个“事件 × 规则”为什么被接受或拒绝；
- `mandates`：真正派发时记录的授权依据。

它们都是只读的。没有开启 Policy 时也会记录来源密钥接受的决定。

## 回答与结案

### 回答提问

```bash
agent-autoloop answer <卡片编号> <选项序号>
agent-autoloop answer <卡片编号> --text "别的想法"
```

- 选项从 1 开始；
- `--text` 用于选项都不合适时写自由回答；
- 只有第一次回答生效；
- 回答后事项继续，通常会续接原会话。

### 结案通知

```bash
agent-autoloop resolve <卡片编号> "已经处理完了"
```

用于不需要做选择的卡片。结案不会凭空启动新一轮；它只是解除阻塞。

### 停止一轮

```bash
agent-autoloop stop <轮次编号>
```

会通知接单程序停止整个进程组；只有进程确实结束后才报告已停。

## 暂停、恢复、补跑

### 暂停

```bash
agent-autoloop pause 处理-issue --reason "在改规则"
agent-autoloop pause 巡检 --until 2026-11-14T09:00:00+08:00
```

暂停期间：

- 定时不跑；
- 事件不接、也不排队；
- 手动运行和补跑也被拒绝；
- 已经领取的轮次不受影响。

`--until` 到点自动恢复，但自动恢复不会像手动 `resume` 那样列出暂停期间跳过的事件。命令行会在暂停时提前打印 `replay` 命令；`status` 在暂停期间也会显示跳过条数和补跑命令，复制保存即可。

### 恢复

```bash
agent-autoloop resume 处理-issue
```

手动恢复会列出暂停期间跳过的事件（最多 20 条），并给出补跑命令。错过的定时时刻不补跑。

### 补跑

```bash
agent-autoloop replay 处理-issue --since 2026-11-13T10:00:00+08:00
```

- `since` 必须带时区；
- 只补这条规则在暂停期间跳过、尚未补过的事件；
- 每条事件只补一次；
- 定时规则不能补跑；
- 被 Policy 拒绝的事件不会因为补跑而接下。

### 立即运行

```bash
agent-autoloop run 处理-issue --subject "#42" --reason "手动检查"
```

走正常派活，记录一条 `run.manual` 事件。暂停中的规则不能立即运行。

## 手动发事件

```bash
agent-autoloop emit issues.opened \
  --subject "owner/repo#42" \
  --summary "新 issue" \
  --detail "正文资料" \
  --link "https://github.com/owner/repo/issues/42"
```

预演路由：

```bash
agent-autoloop emit issues.opened --subject "owner/repo#42" --dry-run
```

`--dry-run` 只读本机规则，不连接中台。`--key` 可指定来源密钥；不写时用 `config.json` 的 `source.key`。

## 接入 Agent

### 内置 Agent

```json
"agents": {
  "claude": { "name": "Claude Code", "worker": "this-machine", "use": "claude" },
  "codex": { "name": "Codex", "worker": "this-machine", "use": "codex" }
}
```

内置实现：

- `claude`：Claude Code；
- `codex`：Codex；
- `dsh`：DeepSeek-Harness；
- `zcode`：ZCode；
- `acp`：ACP 协议；
- `command`：任意命令模板；
- `delivery`：GitHub PR 交付。

### 命令模板

```json
"agent": {
  "name": "My Agent",
  "worker": "this-machine",
  "use": "command",
  "command": ["my-agent", "--prompt", "{prompt}", "--context", "{context}"],
  "access": "read"
}
```

适合任何有打印模式的 CLI。没有会话续接、用量统计和会话链接；需要这些能力时写 Agent 插件。

### 包装脚本

内置 Agent 需要代理、网关或环境变量时：

```bash
#!/bin/sh
export HTTPS_PROXY=http://127.0.0.1:7890
exec codex "$@"
```

```json
"codex": {
  "name": "Codex",
  "worker": "this-machine",
  "use": "codex",
  "program": "/absolute/path/to/codex-wrapper.sh"
}
```

`program` 只替换启动程序，插件仍负责解析输出、续接会话和统计用量。脚本可以读 `AGENT_AUTOLOOP_RUN` 和 `AGENT_AUTOLOOP_CONTEXT`。

## 接入来源

### 直接发标准事件

对方能发 HTTP 时：

1. 新建来源密钥：

   ```bash
   agent-autoloop key new source shop
   ```

2. 在 `rules.json` 登记来源：

   ```json
   "sources": { "shop": { "name": "商店" } }
   ```

3. 对方调用：

   ```bash
   curl -X POST http://127.0.0.1:3350/v1/events \
     -H "Authorization: Bearer <来源密钥>" \
     -H "Content-Type: application/json" \
     -d '{"id":"order-1","type":"order.paid","subject":"order-1","summary":"已付款"}'
   ```

4. 对方可用同一密钥查询：

   ```bash
   curl http://127.0.0.1:3350/v1/events/1 \
     -H "Authorization: Bearer <来源密钥>"
   ```

### Webhook 插件

对方有自己的 Webhook 格式时，写 `plugins/<name>/source.ts`，在 `rules.json` 写 `"adapter": "<name>"`，秘密放 `secrets.env`，地址为 `/v1/in/<来源>`。模板见 [hello-source](../examples/plugins/hello-source/source.ts)。

## 接入通道

### 飞书

```json
// rules.json
"channels": {
  "feishu": { "name": "飞书", "answerers": ["ou_xxx"], "style": "im" }
}
```

```json
// config.json
"channels": {
  "feishu": { "key": "…", "user": "ou_xxx" }
}
```

需要本机安装并登录 `lark-cli`。一个飞书应用只能有一个卡片事件监听。

### 桌面通知

```json
// rules.json
"channels": { "desktop": { "name": "桌面通知" } }
```

```json
// config.json
"channels": { "desktop": { "key": "…" } }
```

桌面通知只适合人在电脑前的情况；无图形界面或远程机器上不会弹窗。

### QQ 机器人

先到 [QQ 开放平台](https://q.qq.com/)创建机器人，拿到 AppID 和 AppSecret，并确认已开通单聊或群聊消息能力。通道走官方 Gateway WebSocket，本机不需要公网地址。

```json
// rules.json
"channels": {
  "qq": { "name": "QQ", "answerers": ["你的 QQ OpenID"] }
}
```

```json
// config.json
"channels": {
  "qq": {
    "key": "…",
    "appId": "机器人 AppID",
    "clientSecret": "机器人 AppSecret",
    "user": "你的 QQ OpenID"
  }
}
```

收卡片的目标二选一：`user` 是单聊 OpenID，`group` 是群 OpenID。群聊里机器人一般只能被动回复，通道会先按配置的目标发送；如果平台要求回复上下文，需在后续版本按事件补充 `msg_id`/`event_id`。`answerers` 用 OpenID，不是 QQ 号。改完 `config.json` 后运行 `agent-autoloop service install` 重启，再用 `agent-autoloop doctor` 看通道是否在线。

QQ 没有修改已发消息的接口，因此卡片状态变化不会在原消息上刷新；中台只确认原消息仍然有效，不会重复发送同一张卡片。需要完整历史时用 `agent-autoloop status`。

### QQ（NapCat）

已经有 NapCat（OneBot 11）在跑时，用内置的 `napcat` 通道，不必去开放平台申请机器人。先在 NapCat 里启用 HTTP 和正向 WebSocket，并设置 access token；通道会在 `config.json` 的 `url` 发消息、在 `ws` 收消息。

```json
// rules.json
"channels": {
  "napcat": { "name": "QQ（NapCat）", "answerers": ["你的 QQ 号"] }
}
```

```json
// config.json
"channels": {
  "napcat": {
    "key": "…",
    "url": "http://127.0.0.1:3000",
    "ws": "ws://127.0.0.1:3000",
    "token": "NapCat access token",
    "user": "你的 QQ 号"
  }
}
```

目标二选一：`user` 是 QQ 号，`group` 是群号。卡片以文字发出，选项写成 `#1`、`#2`；引用卡片消息后回复编号即可回答。只有一张卡片在等时可以直接回 `#1`，有多张时通道会提示引用，不会猜。普通 QQ 消息没有可点击卡片，别把 `answerers` 写成 OpenID——NapCat 提供的是 QQ 号。改完配置运行 `agent-autoloop service install` 重启，再用 `agent-autoloop doctor` 检查通道。

### 专用 QQ：直接派任务并原路收结果

如果想让一个专用 QQ 号充当 Agent 的入口，用内置的 `qq-source` 配合 `napcat`。本人用另一个 QQ 号给专用号发文字，`qq-source` 把它变成 `qq.task`；Agent 的卡片和完成通知由 `napcat` 发回原会话。私聊回私聊，群消息回群。

```json
// rules.json
"sources": { "qq": { "name": "QQ 私聊", "policy": { "allowlist": ["本人 QQ 号"] } } },
"channels": {
  "qq-source": { "name": "QQ 私聊来源" },
  "napcat": { "name": "QQ（NapCat）", "answerers": ["本人 QQ 号"] }
},
"rules": [{
  "name": "QQ 任务",
  "when": { "source": "qq", "types": ["qq.task", "card.answered"] },
  "to": "codex",
  "cwd": "/home/me/work",
  "prompt": "处理 QQ 私聊或群里的任务。消息可以用 /项目名 开头指定项目；同一项目接着原来的会话。",
  "tell": "always",
  "parallel": 4,
  "resume": true
}]
```

```json
// config.json
"channels": {
  "qq-source": {
    "use": "qq-source",
    "key": "…",
    "url": "http://127.0.0.1:3350",
    "ws": "ws://127.0.0.1:3001",
    "token": "NapCat access token",
    "sourceKey": "…",
    "allowed": ["本人 QQ 号"],
    "groups": ["允许派任务的群号"],
    "bot": "专用 QQ 号"
  },
  "napcat": {
    "key": "…",
    "url": "http://127.0.0.1:3001",
    "ws": "ws://127.0.0.1:3001",
    "token": "NapCat access token",
    "user": "本人 QQ 号"
  }
}
```

`allowed` 控制谁能派任务，`groups` 控制哪些群可以派任务，`answerers` 控制谁能回答群卡片。规则必须同时接收 `qq.task` 和 `card.answered`，否则第一轮能跑，回答后不会继续。单独一个 `#N` 是卡片回答，不会变成任务。私聊卡片回原私聊，群卡片回原群；NapCat 通道的 `user` 只做兜底，用于非 QQ 来源的任务和告警。完整步骤和安全边界见 [`examples/qq-private/README.md`](../examples/qq-private/README.md)。

同一个群里讨论多个项目时，用项目前缀分开上下文：

```text
/shop 结算页报错，看一下
/site 首页图片加载慢
/shop 刚才那个问题修好了吗？
```

`/shop` 的消息进入 `qq-group-<群号>/shop`，`/site` 进入 `qq-group-<群号>/site`。规则写 `parallel` 让两个项目各自排队、各自并发；写 `resume` 让同一项目接着上一轮的会话。没有前缀的消息归整个群，共用群这一层。项目短名只能是字母、数字、`.`、`_`、`-`，且 `/项目名` 后必须有空格和任务。

`/项目名` 只分事项，不改变目录和权限。两个项目要改不同的本地仓库时，应分别建规则并配置各自的 `cwd`；前缀不能替代规则隔离。`resume` 的会话会持续变长，长期项目可以按季度换一个短名（如 `/shop-2026q4`）开始新会话。

### Webhook 通道

钉钉、企微、Slack、Discord：

```json
// config.json
"channels": {
  "dingtalk": {
    "use": "webhook",
    "key": "…",
    "platform": "dingtalk",
    "url": "https://…"
  }
}
```

平台也可选 `wecom`、`slack`、`discord`。其他平台可写 `url` 和带 `{text}` 的 `body`。

### 卡片链接

只发文字的平台可给通道配 `"links": true`，卡片会带一个 7 天有效的表单链接。链接持有即授权，不要发到公开位置。

## MCP

MCP 客户端配置：

```json
{
  "mcpServers": {
    "agent-autoloop": {
      "command": "node",
      "args": ["/absolute/path/to/agent-autoloop/bin/agent-autoloop.ts", "mcp"],
      "env": { "AGENT_AUTOLOOP_HOME": "/home/me/.agent-autoloop" }
    }
  }
}
```

MCP 使用本机 `config.json` 已有密钥，不把密钥写进客户端参数。工具按已有身份显示；不自动创建权限。

工具列表：

| 工具      | 作用                                | 密钥 |
| --------- | ----------------------------------- | ---- |
| `status`  | 查看事项、卡片和轮次；`before` 翻页 | 本人 |
| `why`     | 查看一轮的事件、规则和结果          | 本人 |
| `answer`  | 回答卡片；选项从 `0` 开始           | 本人 |
| `resolve` | 结案并写明核实结果                  | 本人 |
| `stop`    | 停止一轮（破坏性操作）              | 本人 |
| `emit`    | 以本机来源发送事件                  | 来源 |
| `tell`    | 以本机来源发送通知                  | 来源 |
| `pause`   | 暂停规则                            | 本人 |
| `resume`  | 恢复规则                            | 本人 |
| `replay`  | 补跑暂停期间跳过的事件              | 本人 |
| `run`     | 立即运行一条规则                    | 本人 |

`status` 和 `why` 只读；`stop` 会终止接单程序进程组。缺少对应密钥时，相关工具不会出现在 `tools/list` 中。

不要把 MCP 配进接单程序启动的 CLI 的用户级配置，否则一轮可能自己回答自己的卡片。

## 备份与恢复

```bash
agent-autoloop backup ~/backups/autoloop-2026-11-13
agent-autoloop restore ~/backups/autoloop-2026-11-13
```

- `backup` 可在中台运行时执行；
- `restore` 必须先停中台；
- 备份包含 `hub.db`、`master.key`、`config.json`、`rules.json`、`secrets.env`；
- 按密钥保管备份；
- 恢复会替换现有配置和规则。

## 升级与卸载

```bash
agent-autoloop update
agent-autoloop uninstall
agent-autoloop uninstall --yes
```

- `update` 跟随最新 Release，并重启服务；
- `uninstall` 删除程序、链接和服务，保留规则、密钥和记录；
- `--yes` 只跳过确认。

## 故障排查

### 连不上中台

```bash
agent-autoloop doctor
```

检查服务是否运行、端口是否正确、中台是否健康。Linux 看：

```bash
journalctl --user -u agent-autoloop -n 100
```

macOS / Windows 看 `~/.agent-autoloop/logs/up.log`。

### Agent 不在线

- 确认工作机运行 `up`；
- 确认 `worker.name` 与 `rules.json` 中 Agent 的 `worker` 一致；
- 运行 `doctor` 检查 Agent 是否安装并登录；
- 检查密钥是否被撤销。

### 卡片没收到

- `status` 看通道是否在线；
- 检查 `defaultChannels` 和规则的 `channels`；
- 检查 `answerers` 是否包含你的平台身份；
- 桌面通知在无图形界面时不会显示。

### 规则不生效

```bash
agent-autoloop check
agent-autoloop rules explain
agent-autoloop emit <类型> --dry-run
```

确认来源 id、事件类型、暂停状态和 Policy 是否拒绝。

### 轮次一直排队

- 检查 worker `capacity`；
- 检查同组 `parallel` 和 `maxActive`；
- 检查工作机是否在线；
- 检查是否有暂停或重试等待。

### 回执没被接受

`why <轮次>` 查看回执问题和原文位置。回执块必须标记为 `agent-autoloop`，字段只使用允许的七项。格式错误只会重写最后一条消息，不会重做业务。
