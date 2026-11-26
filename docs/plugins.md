# 插件开发

插件让 Agent Autoloop 接入新的来源、Agent、通道和交付流程。本文说明三类可加载插件（来源、Agent、通道）的契约，以及交付方向如何复用 Agent 插件。内置通道包括飞书、桌面通知、QQ（经 InSoulForge 机器人）、官方 QQ 机器人直连、QQ（NapCat）直连和 QQ 任务来源；HTTP 细节见 [protocol.md](protocol.md)，配置字段见 [configuration.md](configuration.md)。

QQ 接入分成两组：推荐使用 InSoulForge 机器人链路，聊天、派发任务和结果通知都由机器人统一处理；官方 QQ 机器人、NapCat 和 `qq-source` 仍是独立的可选插件，适合不经过机器人的直连部署。两组插件都保留，按部署方式选择，不要同时消费同一个 QQ 账号。

## 插件是什么

一个插件是一个目录，入口按类型命名：

```text
plugins/<name>/
  agent.ts      # Agent 适配器
  channel.ts    # 通道
  source.ts     # 事件来源
```

也可以只提供其中一种。查找顺序：

1. `~/.agent-autoloop/plugins/<name>/<kind>.ts`（本机安装）
2. `plugins/<name>/<kind>.ts`（内置）

本机同名插件优先。插件加载时会执行代码，因此只安装可信插件。

插件名必须匹配 `[a-z][a-z0-9-]*`。用 `agent-autoloop add <git 地址>` 安装时，仓库名转小写作为插件名；不合法会被拒绝。

## 通用约束

- 插件是 ESM 模块，默认导出；
- 第三方插件应自包含，只用 `node:` 模块和自己目录里的文件；
- 不要相对导入引擎源码；安装在 `~/.agent-autoloop/plugins/` 时相对路径到不了引擎；
- 内置插件可以和引擎一起发布，才可以使用引擎内部工具；
- 插件不反向导入内核，内核不导入插件；
- 插件不应假设中台和它在同一台机器；需要数据时通过 HTTP 协议；
- 新增能力优先用可选字段，不破坏旧插件。

## 先跑起来

在引擎目录运行这条命令：它把三个例子分别装进临时中台，实际走完验签、派活、运行、通知和报告，退出后清理。

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## Agent 插件

### 接口

```ts
type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  tier?: string;
  access: "read" | "edit" | "full";
  command?: string[];
  program?: string;
  contextFile: string;
  folder: string;
};

type Reading = {
  text?: string;
  session?: string;
  usage?: { input?: number; output?: number; cached?: number; cost?: number };
  sessionUsage?: { input?: number; output?: number; cached?: number; cost?: number };
  error?: string;
  finished?: boolean;
  started?: boolean;
};

type Adapter = {
  command(turn: Turn): string[];
  read(stdout: string, code: number | null, stderr: string): Reading;
  link?(session: string): string;
  check?(program?: string): string | null;
};
```

### `command(turn)`

返回命令参数数组，不是 shell 字符串。参数按原样传给进程，不经过 shell 解释。

`turn` 字段：

| 字段                      | 说明                          |
| ------------------------- | ----------------------------- |
| `prompt`                  | 完整提示词                    |
| `session`                 | 新会话可用的 id               |
| `resume`                  | 要续接的会话；新会话为 `null` |
| `cwd`                     | 工作目录                      |
| `access`                  | `read` / `edit` / `full`      |
| `contextFile`             | 资料文件绝对路径              |
| `folder`                  | 资料文件所在目录              |
| `model`、`effort`、`tier` | 规则可选值，可能没有          |
| `command`                 | `use: "command"` 的模板       |
| `program`                 | 规则指定的替代启动程序        |

### `read(stdout, code, stderr)`

在运行中和结束后都会被调用：

- 运行中 `code` 为 `null`；
- 必须能处理未写完的输出；
- 只有真正结束才返回 `text`；
- `started: true` 表示 Agent 已收下提示词，之后失败可在原会话重试；
- `finished: true` 表示这一轮结束，但进程可能还没退出；
- `error` 表示没跑成；
- `session` 用于续接和链接；
- `usage` 是本次启动用量；`sessionUsage` 是会话累计值，由 worker 做差。

不要因为输出暂时不完整就抛错；无法读取时应返回错误信息而不是让解析崩溃。

### `link(session)`

可选。返回用户可打开的会话链接。没有链接不影响回执修复和续接。

### `check(program)`

可选。`doctor` 调用它检查 Agent 是否可用。返回 `null` 表示可用，否则返回可操作的错误文字。

### 最小模板

见 [examples/plugins/hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts)。它用 `printf` 模拟 Agent，不依赖模型。

### 生命周期

1. 规则排队，内核生成 Job；
2. worker 领取，读取 Agent 配置和规则快照；
3. worker 组装 Turn，调用 `command`；
4. 启动独立进程组；
5. 周期性调用 `read`，记录会话和输出；
6. 进程结束或报告 `finished` 后解析回执；
7. 回执错误时只重写最后一条消息，最多两次；
8. 提交结果，清理本地记录。

### access 实际能做什么

`access` 由插件翻译成 CLI 参数，不是内核沙箱：

| 插件        | `read`         | `edit`            | `full`               |
| ----------- | -------------- | ----------------- | -------------------- |
| Codex       | `read-only`    | `workspace-write` | `danger-full-access` |
| Claude Code | `plan`         | `acceptEdits`     | `bypassPermissions`  |
| DSH         | `read-only`    | `workspace-write` | `danger-full-access` |
| ZCode       | `plan`         | `edit`            | `yolo`               |
| ACP         | 同意读和搜索   | 再同意目录内编辑  | 同意所有请求         |
| command     | 由命令自己决定 | 由命令自己决定    | 由命令自己决定       |

只读不等于读不到本机密钥。需要强隔离时使用系统账号或容器。

### 浏览器接入

浏览器工具装在运行 Agent 的电脑上，由该 CLI 的工具配置或项目 Skill 提供。Codex 插件启动的是后台 `codex exec`；可以使用它已配置的 MCP 工具，不能只凭桌面应用能打开网页就认定后台也能访问同一浏览器。

Claude 委托 Codex 的完整规则、Skill 和参数调用脚本见[浏览器交接模板](../examples/recipes/browser-handoff/README.md)。入口命令、目标与允许操作由本人配置；网页助手返回证据和会话编号，主任务负责业务与回执。

已有专用浏览器入口时，在规则的 `prompt` 或 `skill` 写明实际命令、会话接续方式和允许的操作。只交网页步骤，返回看到的内容、操作结果和阻塞原因；主任务负责业务和中台回执。浏览器入口不是必装组件，中台不捆绑某台电脑的脚本，也不自动修改 CLI 的工具配置。

需要网页验收的任务，要用同一后台启动方式实际打开目标页面，核对内容并接续一次会话。缺少可用入口或需要本人恢复连接、登录、验证时，保留未验收项，用现有 `ask` 等待恢复；不要写“没跑成”触发重派，也不能把 HTTP 查询当作已经完成网页验收。

## 通道插件

### 接口

```ts
type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  link: string | null;
  rule?: string;
};

type ChannelContext = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string | null): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
    answer(card: number, body: { choice?: number; text?: string; by?: string; ref?: string }): Promise<unknown>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

export default async function channel(context: ChannelContext): Promise<void>;
```

### 生命周期

1. `up` 启动通道，传入 `hub` 客户端、配置选项、日志函数和 `AbortSignal`；
2. 通道循环调用 `nextCard(50)`；
3. 新卡片（`ref === null`）发送消息；
4. 更新卡片（`ref !== null`）尝试更新原消息；
5. 发送成功调用 `delivered(card, version, ref)`；
6. 发送失败调用 `failed(card, version, error)`；
7. 中台停止时 `signal` 中止，通道应尽快退出；
8. 通道异常退出后 30 秒重启。

### 注意事项

- 卡片内容创建后不变，只有状态和版本变化；
- 支持幂等键的平台，新消息只用卡片编号，不带版本；
- 更新失败时报告失败，不要静默丢弃；
- `answer` 的 `by` 必须是平台可核验身份；
- `ref` 是通道自己的投递引用，不要求是平台消息编号；只要回答时与 `delivered` 回报的一致即可；
- 只发文字的平台可配 `links: true`，用卡片链接回答；
- 不要在一个飞书应用上开两个事件监听。

### 最小模板

见 [examples/plugins/hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts)。

### QQ 接入插件

这一组是独立的直连插件，不是 InSoulForge 接入的组成部分，也不会因为启用机器人链路而删除。用 InSoulForge 做聊天和任务入口时，生产配置通常只启用下一节的 `insoulforge` 回投通道；直连插件仍然保留，供其他部署单独使用。同一个 QQ 账号不要同时接入两组入口。

#### 官方 QQ 机器人

内置的 [QQ 通道](../plugins/qq/channel.ts)走官方 QQ Bot OpenAPI 和 Gateway WebSocket，只用 Node 内置的 `WebSocket`、`fetch` 和 `node:crypto`，不需要 SDK 或公网回调地址。它处理：

- `hello` 后发 `identify`，收到 `READY` 建立会话；断线后带 `session_id` 和 `seq` 发 `resume`；
- 按服务端给的心跳周期发送心跳；
- `INTERACTION_CREATE`（消息按钮）调用 `hub.answer`，再调用 `PUT /interactions/<id>` 确认；
- `C2C_MESSAGE_CREATE` 只记日志，不当作卡片回答；
- 卡片以 Markdown 加内联键盘发出；QQ 没有改消息接口，卡片状态变化只更新中台投递版本，不重复发消息。

配置见[配置手册](configuration.md#channels-1)。按钮回调中的 `button_data` 带卡片编号、选项和一个稳定引用；中台用它核对回答是否来自发出去的那张卡片。`answerers` 仍应填写真实 OpenID，通道不会替规则放宽身份校验。

#### QQ（NapCat）

内置的 [NapCat 通道](../plugins/napcat/channel.ts)走 OneBot 11：HTTP 调 `send_private_msg` / `send_group_msg`，正向 WebSocket 收 `message` 事件。它和官方 QQ Bot 插件分开，因为账号类型、鉴权方式和平台能力都不同。它只用 Node 内置的 `fetch` 和 `WebSocket`，不引入 SDK。

- `user` 和 `group` 二选一，作为没有来源会话时的兜底收件人；带 `reply` 的卡片按来源会话发回私聊或群，因此同一实例可以同时服务多个会话；
- 卡片用文字和 `#1`、`#2` 编号发出，引用卡片消息后回复编号才算回答；
- 只有一张卡片在等时允许直接回编号；多张时必须引用，通道会回一条提示而不是猜；
- 收到按钮以外的普通聊天只当作上下文，不会自动变成回答；
- 发送成功后用稳定引用 `napcat-card-<卡片号>` 上报，重复投递不会在聊天里发第二张；
- WebSocket 断开后每 5 秒重连，HTTP 和 WebSocket 共用可选的 `token`。

配置见[配置手册](configuration.md#channels-1)。NapCat 运行在个人 QQ 账号上，使用前要确认平台规则和账号风险；官方 QQ Bot 仍是需要资质时的选择。这是可选的直连插件，启用 InSoulForge 机器人链路时不需要删除它。

#### QQ 任务来源（`qq-source`）

[`qq-source`](../plugins/qq-source/source.ts) 是一个**常驻来源**，不是传统 webhook：它用正向 WebSocket 连 NapCat，把允许名单里的私聊和群文字翻译成 `qq.task` 事件，再通过 `/v1/events` 交给中台。它由 `host/up.ts` 像通道一样加载，因此同一目录同时提供 `channel.ts` 薄入口。

- 收 `message_type: "private"` 和 `message_type: "group"`；自己的回显、空消息、纯图片都不派任务；
- 只有 `allowed` 里的 QQ 号能派任务；群消息还要求群号在 `groups` 里。发送人写入事件的 `actor`；
- 单独一个 `#N` 是卡片回答，不会变成新任务；
- 消息以 `/项目短名 ` 开头时，事件 `subject` 变成 `qq-<private|group>-<会话>/<项目短名>`，前缀从任务文字中移除；规则写 `parallel` 后，每个项目各成一个 lane，写 `resume` 后各自续接会话；
- 私聊事件带 `reply: "qq-private-<QQ号>"`，群事件带 `reply: "qq-group-<群号>"`，中台校验其格式；NapCat 通道把卡片和通知发回原会话；
- `sourceKey` 只用于提交事件，不进入 Agent 环境；通道密钥和来源密钥分开。

最小可运行配置见 [`examples/qq-private/`](../examples/qq-private/)。规则要同时接收 `qq.task` 和 `card.answered`，否则回答卡片后不会继续，也收不到最终结果。`qq-source` 和 `napcat` 都是可选的直连插件；走 InSoulForge 机器人时只关闭本机通道，不删除插件。

项目短名只接受字母、数字、`.`、`_`、`-`，最长 40 个字符。它只改变事项分组，不改变 Agent、`cwd`、权限或收件人；这些仍由规则和来源配置决定。单独一个 `/shop` 不是空项目，仍按普通文字处理。

### QQ（经 InSoulForge 机器人回投，`insoulforge`）

[`insoulforge`](../plugins/insoulforge/channel.ts) 是**回投通道**，不是收消息的机器人口。它把中台的提问、完成和后续卡片通过 InSoulForge 的 Activity `notify` 发回聊天，让机器人结合上下文决定：直接回复、继续派任务、追问，或保持安静。

```text
QQ ⇄ NapCat ⇄ InSoulForge ⇄ autoloop Activity（收任务）
                              ↕
                 insoulforge 回投通道（发结果）
                              ↓
                       Agent Autoloop
```

```json
// rules.json
"channels": {
  "insoulforge": { "name": "QQ（经机器人）", "answerers": ["1991849113"], "style": "im" }
}
```

```json
// config.json
"channels": {
  "insoulforge": {
    "key": "通道密钥",
    "activityUrl": "ws://127.0.0.1:7778/activities/ws",
    "activityToken": "InSoulForge Activity Token",
    "activityName": "autoloop-outbox",
    "fallback": "private:1991849113"
  }
}
```

`fallback` 是**没有 QQ 来源会话的卡片**（例如 GitHub 事件、定时任务、中台告警）默认发往的私聊。带 `reply` 的卡片仍回原会话。

回投通道只发 Activity 通知，不直接连 NapCat，也不消费 QQ 消息。它默认每 20 秒发一次 `status` 心跳，避免 InSoulForge 按 45 秒无入站帧断开。收消息由 `integrations/insoulforge` 的 `autoloop` Activity 负责。两者不能同时用同一个 Activity 名称。完成和提问通知使用 `force`，由 Router 硬规则触发回复；进度通知使用 `judge`，允许聊天模型判断是否值得打扰。生产上启用 `insoulforge` 回投时，应移除 `napcat` 和 `qq-source` 通道，否则同一条消息可能被两个入口消费；这只是关掉这一台机器的重复入口，不删除对应的直连插件。

经 InSoulForge 的 `projects` 配置应显式保留一个通用 lane（通常叫 `general`），承接天气、资料、新闻、计算等与代码仓库无关的任务。只有代码项目可选时，模型容易被“必须从列表里选一个”逼着猜中第一个项目，把通用问题记到错误的项目上下文里。`general` 规则用独立 `cwd` 和 `subjects`，但不要开 `resume`，避免不同通用问题串会话。

发送人身份由 InSoulForge 从本轮消息快照提取，并通过活动请求的 `context.sender_id` 单独注入，不放进模型可写的
`parameters`。Activity 用 `allow.senders` 校验派任务、回答卡片、查看进度和项目清单的真实发送人；私聊和群聊缺少该身份时拒绝，而不是退回到配置里的
操作者。旧版 InSoulForge 不发送 `context` 时，只应在本机可信、群内成员都可信的部署里使用兼容模式。

回投正文开头带固定状态标签，机器人路由可以直接匹配，不必从措辞猜：

- `[Autoloop 状态] 完成`：任务完成或已结案的回执，必须转告用户。
- `[Autoloop 状态] 提问`：需要用户决定的问题，必须转告用户。
- `[Autoloop 状态] 进度`：普通进度，允许机器人结合上下文保持安静。

标签之后仍保留 `[系统通知] 会话：<target>`，让机器人知道后续追问或继续派单该发回哪个 QQ 会话。InSoulForge 的 Router 提示词应把“完成”和“提问”当作必须回复的硬规则，不能因为“只是系统通知”或“和上一条重复”而跳过。

通道在重启后会跳过启动前已存在且从未投递过的历史卡片，不补发旧任务；启动前已经投递过的卡片仍可更新投递版本。每张新卡片使用稳定引用 `insoulforge-card-<编号>`；更新只确认投递版本，不重复发消息。

完整部署和 Activity 契约见 [`integrations/insoulforge/README.md`](../integrations/insoulforge/README.md)。

## 事件来源插件

### 接口

```ts
type Input = {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secret: string;
};

export default function source(input: Input): EventInput[];
```

事件字段：

```ts
type EventInput = {
  id: string;
  type: string;
  subject?: string;
  summary?: string;
  detail?: string;
  link?: string;
  actor?: string;
  hops?: number;
};
```

### 约束

- 同步函数，不返回 Promise；
- 只翻译，不发请求；
- 必须验签；失败抛错，返回 401；
- `id` 必须稳定，用于去重；
- `type` 必须匹配 `[a-z][a-z0-9_.-]{0,63}`；
- `subject` 和 `actor` 只能用 `[A-Za-z0-9#._:/@-]`；
- `link` 只能是 ASCII HTTP(S)；
- 长度上限见协议；
- `actor` 用于 Policy，取不到就留空；
- 插件不需要认识 Policy。

### 注册

```json
"sources": {
  "shop": { "name": "商店", "adapter": "hello-source" }
}
```

Webhook 地址：`/v1/in/shop`。

秘密：

```dotenv
AGENT_AUTOLOOP_SECRET_SHOP=...
```

来源 id 转大写、`-` 换成 `_`。

### 最小模板

见 [examples/plugins/hello-source/source.ts](../examples/plugins/hello-source/source.ts)。

## 交付方向

交付不是第四种加载入口，而是普通 Agent 插件加规则、轮询脚本和 GitHub 状态组成的项目级方向。内置实现位于 `plugins/delivery/`：`agent.ts` 是普通 Agent 插件，`run.ts` 执行交付流程，`poll.ts` 发现带 `deliver` 标签的 PR。新交付流程应复用 Agent 插件契约，不需要改内核或新增加载类型。

配置示例：

```json
"agents": {
  "poll": {
    "name": "查看交付标签",
    "worker": "mac-mini",
    "use": "command",
    "command": ["node", "/absolute/path/plugins/delivery/poll.ts", "owner/app"]
  },
  "delivery": {
    "name": "交付",
    "worker": "mac-mini",
    "use": "delivery",
    "command": ["owner/app"],
    "timeout": 35
  }
}
```

完整流程、标签、审查策略和发布核对见 [SKILL.md](../skills/agent-autoloop/SKILL.md#交付流水线) 与 [protocol.md](protocol.md#交付插件)。

交付方向不是内核的一部分；它通过普通规则和 Agent 轮次运行。交付状态以 GitHub 为准，中台只负责排队、重试、通知和记录。

## 安装插件

```bash
agent-autoloop add https://github.com/you/my-plugin.git
```

安装到 `~/.agent-autoloop/plugins/my-plugin`：

- 只克隆，不安装依赖；
- 不运行安装脚本；
- 不自动更新；
- 同名本机插件优先于内置插件；
- 安装后修改 `rules.json` 的 `use` 或 `adapter`。

## 一致性测试

在引擎目录运行协议的现有 HTTP 检查，全部使用临时数据和随机端口：

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

## 测试插件

### 最小模板测试

在引擎目录运行：

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

它会把三个示例插件装进临时中台，走完验签、派活、执行、通知和报告。

### 协议一致性

```bash
agent-autoloop conformance <测试中台地址> --config <凭据文件>
```

会写事件和卡片，只能对专用测试中台运行。

### 单元测试

- Agent 插件：给定 Turn 检查命令参数；给定输出检查 `read` 结果；
- 通道插件：用假 `hub` 检查领取、送达、失败和回答；
- 来源插件：用固定请求检查验签、字段映射和错误；
- 不要连接真实业务系统或发送真实消息。

## 兼容规则

- 新字段可选，旧插件忽略即可；
- 不重命名已发布字段；
- 不改变已有字段语义；
- 新增事件类型不破坏旧规则；
- 插件名和入口路径保持稳定；
- 破坏性变更要升主版本并在发布说明中写明。

## 调试

- 通道和 worker 日志写入服务日志；
- Agent 输出保存在 `worker/runs/<run>-<attempt>/`；
- 用 `agent-autoloop why <轮次>` 查看时间线；
- 用 `agent-autoloop doctor` 检查程序和登录；
- 插件抛错会记录在日志，但不会让中台崩溃；
- 通道异常退出后 30 秒重启，注意避免无限重启风暴。
