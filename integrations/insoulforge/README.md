# InSoulForge Activity 接入

这个目录把 InSoulForge 的聊天前台接到 Agent Autoloop。人只和 QQ 里的 InSoulForge 说话：

```text
QQ 私聊/群聊 ⇄ NapCat ⇄ InSoulForge
                            │ request_activity("autoloop", …)
                            ▼
                    insoulforge Activity
                            │ HTTP（只在本机）
                            ▼
                    Agent Autoloop
                            │
                            ▼
                      项目 Agent
```

InSoulForge 负责人设、聊天记忆、会话启停和 QQ 收发；Autoloop 负责规则、任务队列、项目隔离、卡片和 Agent 执行。两边通过 InSoulForge 的 [Activity 协议](https://github.com/DreamDonghao/insoulforge/blob/main/docs/ACTIVITIES.md) 连接，不改 InSoulForge 的业务代码。

## 为什么不是两个 QQ 来源

Autoloop 自带的 `qq-source` 和 InSoulForge 不能同时消费同一个 NapCat 消息，否则同一条消息会派两次任务。启用本接入后：

- NapCat 只由 InSoulForge 接收消息；
- Autoloop 用 `insoulforge` 回投通道把卡片和结果交给机器人，不再直连 QQ；
- 不要在本机同时启用 `napcat` 或 `qq-source` 通道。

`plugins/qq`、`plugins/napcat` 和 `plugins/qq-source` 仍是独立的可选直连插件，代码和安装都保留；这里只是不在同一台 InSoulForge 部署里同时启用它们，避免同一个 QQ 消息被两个入口消费。

## 模型能看到当前会话吗

能看到。InSoulForge 每轮把 `current_session` 放进 Executor 上下文：

```json
{"type":"group","group_id":20002002,"group_name":"…"}
{"type":"private","user_id":10001001}
```

Activity 协议本身不注入会话，所以工具的 `instructions` 要求模型把 `target_session` 写成 `group:<群号>` 或 `private:<QQ号>`。Activity 把它当作**模型传入的不可信文字**，提交前按 `allow` 白名单再次校验。模型不能通过改这段文字去操作别的群或私聊。

## 使用

### 1. InSoulForge 开启 Activity

管理后台 →「Activity」→ 设置接入 Token（至少 16 个字符）并保存。服务连接：

```text
ws://127.0.0.1:7778/activities/ws
Authorization: Bearer <Activity Token>
```

### 2. 配置本地服务

复制 `config.example.json` 为 `config.json`，填：

| 字段             | 说明                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `activity.url`   | InSoulForge 地址，默认 `ws://127.0.0.1:7778/activities/ws`                                                |
| `activity.token` | 后台设置的 Activity 接入 Token                                                                            |
| `hub.url`        | Autoloop 地址，默认 `http://127.0.0.1:3350`                                                               |
| `hub.sourceKey`  | Autoloop 的 `source` 密钥，用来提交 `qq.task`                                                             |
| `hub.ownerKey`   | Autoloop 的 `owner` 密钥，用来查状态和回答卡片                                                            |
| `allow.private`  | 允许发生私聊会话的 QQ 号                                                                                  |
| `allow.groups`   | 允许派任务的群号                                                                                          |
| `allow.actor`    | 经 InSoulForge 进来的任务统一使用的可信操作者 QQ 号，必须是 `allow.private` 里的人                        |
| `allow.senders`  | 允许派任务、回答卡片、查看进度和项目清单的真实 QQ 号；身份由 InSoulForge 注入，缺省时沿用 `allow.private` |
| `projects`       | 项目短名、说明和对应规则；可以保留一个 `general` 通用任务 lane，拿不准时不必填项目                        |

项目短名必须是 ASCII：字母、数字、`.`、`_`、`-`，因为 Autoloop 的 `subject` 只接受这些字符；中文说明放在 `description`。

`projects` 是模型可显式指定的项目提示，不是必须填的字段。明确知道项目时传 `project_hint`；拿不准就省略，交给 Autoloop 的调度 Agent 判断。明确的天气、资料、新闻、查询等通用任务可以选 `general`，但不要为了凑一个项目而猜第一个代码项目：

```json
"projects": {
  "sub2api": { "description": "Sub2API 后端与前端", "rule": "QQ 任务 sub2api" },
  "general": { "description": "通用任务：天气、资料、新闻、查询等，不属于任何代码仓库", "rule": "QQ 通用任务" }
}
```

如果保留 `general`，对应规则应使用独立的 `cwd`（例如 `/home/mini/work`），并让 `subjects` 匹配 `qq-group-<群号>/general*` 与 `qq-private-<QQ号>/general*`。不要给 `general` 开启 `resume`：不同通用问题共享一个会话会串上下文；回答卡片仍会回到原线程。没有 `general` 或不想指定时，省略 `project_hint`，由调度按项目说明选择或转成未分配卡片。

**密钥不进模型。** `sourceKey` 和 `ownerKey` 只由本服务读取；模型只能通过 Activity 的受控动作使用它们。不要把 `ownerKey` 配进聊天机器人的系统提示词或插件参数。

### 3. 启动

```bash
cd integrations/insoulforge
node --disable-warning=ExperimentalWarning main.ts
```

或：

```bash
npm start
```

服务会主动连 InSoulForge，不监听端口。InSoulForge 重启或断线后，1、2、4……最多 30 秒退避重连。

`activity.json` 修改后会自动重载：合法配置替换项目清单和白名单，并重连重新注册，让模型看到新的项目说明；非法配置只记录日志，继续使用旧配置，不需要重启服务。推荐用 `agent-autoloop project add` 同步更新 `rules.json` 和这份文件，而不是只改其中一份。

### 4. 部署为 systemd user service

```ini
[Unit]
Description=InSoulForge Activity for Agent Autoloop

[Service]
WorkingDirectory=/home/mini/agent/vendor/agent-autoloop/integrations/insoulforge
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning main.ts
Environment=INSOULFORGE_ACTIVITY_CONFIG=/home/mini/.insoulforge/activity.json
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now insoulforge-activity
```

生产配置建议放在 `~/.insoulforge/activity.json`，权限 `600`。

## 工具契约

InSoulForge 只有一个工具：`request_activity(name, parameters)`，`name` 是 `autoloop`。

### `submit`

```json
{
  "action": "submit",
  "project_hint": "shop",
  "text": "结算页报错，修一下",
  "target_session": "group:20002002"
}
```

产生：

```json
{
  "type": "qq.task",
  "subject": "qq-group-20002002/shop",
  "detail": "结算页报错，修一下",
  "actor": "10001001",
  "reply": "qq-group-20002002"
}
```

`actor` 取本轮消息的真实发送人，不再固定成某个操作者。InSoulForge 从冻结的消息快照中提取本轮唯一的人类发送人，作为
Activity 请求的独立 `context.sender_id` 注入；模型参数 `parameters` 里写同名值不会生效。私聊和群聊请求缺少该字段、发送人不在
`allow.senders`、或私聊注入的身份与 `private:<QQ号>` 不一致时，服务直接拒绝。`status` 和 `projects` 也使用这套身份校验，未授权成员不能看到任务明细或项目清单。只有 `allow.senders` 为空时才沿用旧的
可信操作者模式，兼容尚未支持 `context` 的 InSoulForge 构建。

InSoulForge 同时把当前会话作为 `context.session_id` 注入。`target_session` 必须与它一致，因此模型不能把任务或卡片回答改投另一个同样在
`allow` 里的群或私聊。尚未发送 `context.session_id` 的旧构建仍只校验目标白名单。

因此群内是否允许派任务由 `allow.senders` 决定，而不是由群是否在 `allow.groups` 里决定。只想自己派任务时，把
`allow.senders` 设成自己的 QQ 号；群里其他人仍可聊天，但无法派任务或回答卡片。

传了 `project_hint` 时，`subject` 带项目短名，同一群里不同项目各走一条 lane；规则写 `parallel` 和 `resume` 时各自排队、各自续接上下文。没传时 `subject` 是会话级 lane（例如 `qq-group-20002002`），Autoloop 的调度 Agent 选好项目后再规范成 `qq-group-20002002/<项目>`，不会让两个项目共享上下文。`reply` 让卡片、调度结果和完成通知回到原私聊或原群。

提交成功返回：

```json
{
  "success": true,
  "result": {
    "submitted": true,
    "id": "insoulforge:…",
    "project": "shop",
    "target_session": "group:20002002",
    "routed": ["QQ 任务"],
    "run": 42,
    "run_state": "queued",
    "summary": "结算页报错，修一下",
    "accepted": true,
    "ack": "已派单给 Agent Autoloop（项目：shop，任务 #42）。任务：结算页报错，修一下"
  }
}
```

没有 `project_hint` 时，`project` 字段为空、`pending` 为 true，`ack` 是“已提交，正在判断属于哪个项目”。这表示任务已经写入中台，不能向用户说“没有规则接单”。`accepted=false` 只在明确没有调度、也没有规则接单时出现；`ack` 会如实说明。执行器在 `request_activity` 成功后会把 `ack` 作为确定性回执发给用户：模型自己已发过回复时追加一条，没发时补发一条。提交失败返回 `success=false`，模型必须把失败原因告诉用户。

任务完成、失败或需要用户决定时，Autoloop 的 `insoulforge` 回投通道发送 `[Autoloop 状态] 完成/提问` 通知，并使用 `mode=force` 触发回复；进度通知使用 `judge`，允许聊天模型判断是否值得打扰。

### `status`

```json
{ "action": "status", "project": "shop", "target_session": "group:20002002" }
```

`project` 和 `target_session` 都可省略。只返回白名单会话里的数据，不让一个群看到另一个群的卡片和任务。

运行中的任务会带最近一步进展，`summary` 里形如 `#42 运行中：修结算页（进展：修改文件：src/app.ts）`，结构化结果在 `runs[].progress`。进度只是展示，不改变任务状态；完整时间线用 `agent-autoloop why 42` 看。

### `answer`

```json
{ "action": "answer", "card": 12, "choice": 2, "target_session": "group:20002002" }
```

或文字回答：

```json
{ "action": "answer", "card": 12, "text": "用方案 A", "target_session": "group:20002002" }
```

`choice` 从 1 开始。服务先查 `/v1/state`，确认这张卡片确实属于该会话且仍在等待回答，再用 `ownerKey` 调用 `/v1/cards/<id>/answer`。回答不会在本服务里另起一轮，Autoloop 会把 `card.answered` 接回原项目上下文。

### `projects`

返回项目短名、说明和对应规则，不返回 `cwd`、Agent、权限或密钥。

## 安全边界

- `target_session` 必须是 `group:<数字>` 或 `private:<数字>`，且在该项目的 `allow` 白名单里；
- 项目只能从 `projects` 配置里选，聊天文字不能改 `cwd`、Agent、权限或收件人；
- `answer` 只接受当前会话中仍开放的卡片；
- 不把 `sourceKey`/`ownerKey` 返回给模型或 InSoulForge；
- 服务只主动连接 InSoulForge，不额外开放端口；
- InSoulForge 的 Activity 通知没有可靠投递保证；Autoloop 的 `insoulforge` 回投通道用稳定引用去重，机器人仍应按通知内容判断是否已经处理。不要为了防丢失再并行启用直连 QQ 通道，否则同一条消息会被两个入口消费。

## 测试

```bash
cd integrations/insoulforge
node --disable-warning=ExperimentalWarning --test tests/*.test.ts
npx tsc -p tsconfig.json
```

测试覆盖：目标白名单、项目 lane 隔离、状态过滤、卡片归属校验、一号 choice、提交事件形状、Hub 失败转普通错误、WebSocket Authorization 头、注册/请求/响应链路。
