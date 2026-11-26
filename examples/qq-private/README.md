# 专用 QQ：直接派任务、原路收结果

这个例子让一个**专用 QQ 号**充当 Agent Autoloop 的入口：本人用另一个 QQ 号给它发消息，消息变成一个 `qq.task` 事件；Agent 做完后，卡片和完成通知回到原会话。私聊回私聊，允许群里的消息回群。群任务默认关闭，要在 `config.json` 写 `groups` 才开启。

```text
本人 QQ ──私聊──▶ 专用 QQ（NapCat） ──正向 WebSocket──▶ qq-source
                                                          │ POST /v1/events
                                                          ▼
                                                       中台规则 ──▶ Agent
                                                          │
                                                          ▼
                                       NapCat 通道 ──原会话──▶ 本人 QQ / 群
```

## 先准备

1. 一个专门给 Agent Autoloop 用的 QQ 号，并让它登录 NapCat；不要和另一个“对话机器人”共用同一个 QQ 号。
2. NapCat 已启用 OneBot HTTP 和**正向 WebSocket**。本机通常 HTTP 是 `http://127.0.0.1:3001`，正向 WebSocket 是 `ws://127.0.0.1:3001`。
3. 记下 OneBot access token、专用 QQ 号和本人的 QQ 号。

## 生成密钥

在装 Autoloop 的机器上运行：

```bash
agent-autoloop key new source qq
agent-autoloop key new channel qq-source
agent-autoloop key new channel napcat
agent-autoloop key new worker this-machine
agent-autoloop key new owner me
```

分别替换 `rules.json` / `config.json` 中的占位符。`sourceKey` 只给 `qq-source` 使用，不要写进 Agent 的环境变量。

## 合并配置

- 把 `rules.json` 的 `sources`、`agents`、`channels` 和 `rules` 合并到 `~/.agent-autoloop/rules.json`，保留已有条目。
- 把 `config.json` 的 `channels` 合并到 `~/.agent-autoloop/config.json`，保留已有中台、worker 和 owner。
- 所有 `YOUR_QQ_NUMBER` 换成本人 QQ 号；`BOT_QQ_NUMBER` 换成专用 QQ 号；`REPLACE_WITH_*` 换成上一步的密钥。
- `cwd` 改成 Agent 实际工作的绝对目录，例如 `/home/me/work`。
- `allowed` 和 `answerers` 都要填本人 QQ 号。`allowed` 控制谁能派任务，`answerers` 控制谁能回答卡片；两处都不填或填错，消息会被忽略或拒绝回答。
- 要收群任务，在 `config.json` 的 `qq-source` 里加 `"groups": ["群号"]`；不在这个列表里的群不会产生任务。

## 规则要点

```json
"when": { "source": "qq", "types": ["qq.task", "card.answered"] }
```

`qq.task` 是新任务，`card.answered` 是本人回答卡片后继续同一件事。只写 `qq.task` 的话，第一轮能跑，回答后不会继续，也收不到最终结果。

`"tell": "always"` 让每轮完成都回一条通知；不想收到成功通知可以改成 `"needed"`。

要在同一个群里分开多个项目，规则还要写 `"parallel": 4` 和 `"resume": true`，消息开头用 `/项目短名`：

```text
/shop 结算页报错，看一下
/site 首页图片加载慢
/shop 刚才那个问题修好了吗？
```

`/shop` 和 `/site` 各自成一个事项、各自续接会话；回答卡片时也沿用原项目。没有前缀的消息归整个群，共用群这一层。项目短名只分事项，不改变 `cwd` 和权限。

## 使用

1. 启动/重启：`agent-autoloop service install`（或前台 `agent-autoloop up`）。
2. 检查：`agent-autoloop doctor`，确认 `qq-source` 和 `napcat` 两个通道都在线。
3. 用本人 QQ 私聊专用 QQ 号，直接在允许的群里 @ 或发任务文字。群里建议带上 `/项目名`。
4. Agent 需要拍板时会发一张带 `#1`、`#2` 的卡片；引用卡片消息回复 `#1`，或只有一张待答卡片时直接回 `#1`。
5. 完成通知会回到原私聊或原群。

## 安全边界

- 只有 `allowed` 里的 QQ 号能派任务；群消息还要求群号在 `groups` 里。自己的回显、空消息和纯图片都不是任务。
- 单独一个 `#N` 被保留为卡片回答，不会变成新任务。
- QQ 文字是**数据**，不能指定 Agent、工作目录、权限或收件人；这些只由 `rules.json` 决定。
- `reply` 字段只能是 `qq-private-<QQ号>` 或 `qq-group-<群号>`，由中台校验；Agent 不能自己指定回送对象。
- `qq-source` 和 `napcat` 使用不同的通道密钥；`sourceKey` 只用于提交事件。

## 常见问题

**消息发出去了但没反应**：先看 `agent-autoloop doctor` 和日志。确认 `allowed` 是本人大号 QQ；群消息还要确认群号在 `groups` 里，且消息是纯文字。`#1` 这类消息不会创建任务。

**卡片回来了但回答无效**：`answerers` 要填本人 QQ 号；必须引用通道发出的那张卡片，或在只有一张待答卡片时直接回编号。

**结果没有回到本人**：检查规则是否同时接收 `card.answered`，以及 NapCat 是否在线。卡片和通知会带来源会话：私聊是 `qq-private-<本人QQ号>`，群是 `qq-group-<群号>`。

**不要同时让两个机器人登录同一个 QQ 号**：NapCat 只能有一个 OneBot 客户端稳定接收消息；如果要另做一个“对话机器人”，用另一个 QQ 号，由它确认任务后再通过 `qq-source` 的同一个事件接口提交。
