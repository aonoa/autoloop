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
{"type":"group","group_id":742118793,"group_name":"…"}
{"type":"private","user_id":1991849113}
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

| 字段             | 说明                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| `activity.url`   | InSoulForge 地址，默认 `ws://127.0.0.1:7778/activities/ws`                         |
| `activity.token` | 后台设置的 Activity 接入 Token                                                     |
| `hub.url`        | Autoloop 地址，默认 `http://127.0.0.1:3350`                                        |
| `hub.sourceKey`  | Autoloop 的 `source` 密钥，用来提交 `qq.task`                                      |
| `hub.ownerKey`   | Autoloop 的 `owner` 密钥，用来查状态和回答卡片                                     |
| `allow.private`  | 允许发生私聊会话的 QQ 号                                                           |
| `allow.groups`   | 允许派任务的群号                                                                   |
| `allow.actor`    | 经 InSoulForge 进来的任务统一使用的可信操作者 QQ 号，必须是 `allow.private` 里的人 |
| `allow.senders`  | 允许派任务、回答卡片、查看进度和项目清单的真实 QQ 号；身份由 InSoulForge 注入，缺省时沿用 `allow.private` |
| `projects`       | 项目短名、说明和对应规则；建议保留一个 `general` 通用任务 lane                     |

项目短名必须是 ASCII：字母、数字、`.`、`_`、`-`，因为 Autoloop 的 `subject` 只接受这些字符；中文说明放在 `description`。

除代码仓库外，建议显式配置一个通用项目，否则天气、资料、新闻等任务没有合适的 lane，模型可能在必须选择时猜成第一个代码项目：

```json
"projects": {
  "sub2api": { "description": "Sub2API 后端与前端", "rule": "QQ 任务 sub2api" },
  "general": { "description": "通用任务：天气、资料、新闻、查询等，不属于任何代码仓库", "rule": "QQ 通用任务" }
}
```

对应的 `general` 规则应使用独立的 `cwd`（例如 `/home/mini/work`），并让 `subjects` 匹配 `qq-group-<群号>/general*` 与 `qq-private-<QQ号>/general*`。不要给 `general` 开启 `resume`：不同通用问题共享一个会话会串上下文；回答卡片仍会回到原线程。

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
  "project": "shop",
  "text": "结算页报错，修一下",
  "target_session": "group:742118793"
}
```

产生：

```json
{
  "type": "qq.task",
  "subject": "qq-group-742118793/shop",
  "detail": "结算页报错，修一下",
  "actor": "1991849113",
  "reply": "qq-group-742118793"
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

`subject` 带项目短名，所以同一群里不同项目各走一条 lane；规则写 `parallel` 和 `resume` 时各自排队、各自续接上下文。`reply` 让卡片和完成通知回到原私聊或原群。

提交成功返回：

```json
{
  "success": true,
  "result": {
    "submitted": true,
    "id": "insoulforge:…",
    "project": "shop",
    "target_session": "group:742118793",
    "routed": ["QQ 任务"],
    "run": 42,
    "run_state": "queued",
    "summary": "结算页报错，修一下",
    "accepted": true,
    "ack": "已派单给 Agent Autoloop（项目：shop，任务 #42）。任务：结算页报错，修一下"
  }
}
```

`accepted=false` 表示事件已写入中台，但没有规则接单；`ack` 会明确说明这一点，不能向用户谎称已开始执行。执行器在 `request_activity` 成功后会把 `ack` 作为确定性回执发给用户：模型自己已发过回复时追加一条，没发时补发一条。提交失败返回 `success=false`，模型必须把失败原因告诉用户。

任务完成、失败或需要用户决定时，Autoloop 的 `insoulforge` 回投通道发送 `[Autoloop 状态] 完成/提问` 通知，并使用 `mode=force` 触发回复；进度通知使用 `judge`，允许聊天模型判断是否值得打扰。

### `status`

```json
{ "action": "status", "project": "shop", "target_session": "group:742118793" }
```

`project` 和 `target_session` 都可省略。只返回白名单会话里的数据，不让一个群看到另一个群的卡片和任务。

### `answer`

```json
{ "action": "answer", "card": 12, "choice": 2, "target_session": "group:742118793" }
```

或文字回答：

```json
{ "action": "answer", "card": 12, "text": "用方案 A", "target_session": "group:742118793" }
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
