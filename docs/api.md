# API 速查

本文是 HTTP 接口的快速索引。字段、边界和示例的完整说明以 [protocol.md](protocol.md) 为准，类型定义见 `protocol/schema.json`。

## 基本约定

- 业务接口使用 HTTP + JSON；例外是 `/c/<token>` 的 HTML 表单、`/v1/stream` 的 SSE，以及 `/v1/in/<来源>` 接收来源自己的原始 Webhook 请求；
- 鉴权头：`Authorization: Bearer <密钥>`；
- 响应默认 `cache-control: no-store`；
- 请求体上限 1024 KB，超过返回 413；
- 错误响应：`{ "error": "说明" }`；
- 状态码：400 输入错误、401 鉴权失败、404 不存在、409 冲突、413 过大、500 内部错误；
- 长轮询 `wait` 最大 50 秒；
- 事件编号和轮次编号从 1 开始。

## 密钥种类

| 种类 | 能做什么 |
| --- | --- |
| `source` | 发事件、查自己发出的事件结果、发 `tell` |
| `worker` | 领活、心跳、发 `tell` 或定时任务提问；提交 started/result 使用该轮 token |
| `channel` | 领卡片、报告投递、以平台身份回答 |
| `owner` | 看状态、日志流、回答、结案、停止、暂停、恢复、补跑、手动运行、删除密钥 |

密钥只保存哈希。卡片链接和轮次 token 由 `master.key` 派生。

## 端点矩阵

| 方法 | 路径 | 鉴权 | 作用 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 无 | 健康检查，返回 `{ ok, commit }` |
| `POST` | `/v1/events` | source | 写入标准事件 |
| `GET` | `/v1/events/<编号>` | source | 查自己发出事件的结果 |
| `POST` | `/v1/in/<来源>` | 无（插件验签） | Webhook 入口，交给来源插件翻译 |
| `GET` | `/v1/work` | worker | 长轮询领活、心跳 |
| `POST` | `/v1/runs/<轮次>/started` | 轮次 token | 报告会话和链接 |
| `POST` | `/v1/runs/<轮次>/result` | 轮次 token | 提交结果和回执 |
| `POST` | `/v1/runs/<轮次>/cancel` | owner | 停止一轮 |
| `GET` | `/v1/runs/<轮次>/why` | owner | 查一轮时间线 |
| `GET` | `/v1/cards/next` | channel | 长轮询领取卡片 |
| `POST` | `/v1/cards/<卡片>/delivered` | channel | 报告已送达 |
| `POST` | `/v1/cards/<卡片>/failed` | channel | 报告投递失败 |
| `POST` | `/v1/cards/<卡片>/answer` | channel 或 owner | 回答卡片 |
| `POST` | `/v1/cards/<卡片>/resolve` | owner | 结案 |
| `POST` | `/v1/tell` | source 或 worker | 主动告知或定时任务提问 |
| `GET` | `/v1/state` | owner | 看全局状态 |
| `GET` | `/v1/stream` | owner | SSE 日志流 |
| `POST` | `/v1/rules/<规则>/pause` | owner | 暂停规则 |
| `POST` | `/v1/rules/<规则>/resume` | owner | 恢复规则 |
| `POST` | `/v1/rules/<规则>/run` | owner | 立即运行 |
| `POST` | `/v1/rules/<规则>/replay` | owner | 补跑暂停跳过的事件 |
| `DELETE` | `/v1/keys/<种类>/<名字>` | owner | 删除密钥 |
| `GET` | `/c/<链接 token>` | 链接 token | 卡片表单 |
| `POST` | `/c/<链接 token>` | 链接 token | 提交卡片表单 |

## 来源

### 写事件

```http
POST /v1/events
Authorization: Bearer <source-key>
Content-Type: application/json

{
  "id": "issue-42-opened",
  "type": "issues.opened",
  "subject": "owner/repo#42",
  "summary": "新 issue",
  "detail": "正文",
  "link": "https://github.com/owner/repo/issues/42",
  "actor": "alice",
  "hops": 0
}
```

响应：

```json
{
  "event": 12,
  "duplicate": false,
  "routed": ["处理 issue"],
  "paused": []
}
```

- 同一来源同一 `id` 重复提交返回 `duplicate: true`；
- `routed` 是实际排进一轮的规则；
- `paused` 是因暂停未接的规则；
- 被 Policy 拒绝的规则在 `refused` 中。

### 查事件结果

```http
GET /v1/events/12
Authorization: Bearer <source-key>
```

返回 `event`、`routed`、`paused`、`refused` 和 `runs`。只有来源自己通过 `/v1/events` 发出的事件可查；别的来源看到的是 404。

## `tell`

`/v1/tell` 按密钥种类接受不同结构。

来源主动告知：

```http
POST /v1/tell
Authorization: Bearer <source-key>

{ "key": "检查完成", "text": "夜间巡检没有发现问题" }
```

worker 为分配给它的 `elsewhere` 任务告知或提问：

```http
POST /v1/tell
Authorization: Bearer <worker-key>

{ "key": "检查完成", "task": "每周清理", "text": "已清理 12 个文件" }

POST /v1/tell
Authorization: Bearer <worker-key>

{ "task": "每周清理", "ask": { "title": "删掉旧备份吗？", "text": "…", "options": ["删", "保留"], "recommend": 1 } }
```

- `key` 是调用方的幂等键；同一来源或同一任务再次发送同一 `key` 返回 `duplicate: true`；
- `text` 最多 20000 字；
- worker 的 `task` 必须是 `rules.json` 的 `elsewhere` 中分配给该 worker 的任务，否则返回 401；
- 来源不能提问；worker 不能借 `/v1/tell` 发送任意标准事件。

## Worker

### 领活

```http
GET /v1/work?claim=<本次领取编号>&wait=50&running=<轮次列表>&capacity=1
Authorization: Bearer <worker-key>
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `claim` | 是 | 本次领活编号，最多 200 字 |
| `wait` | 否 | 长轮询秒数，最大 50 |
| `running` | 否 | 正在执行的轮次，逗号分隔 |
| `capacity` | 否 | `0` 表示满员，不领新活 |

响应：

```json
{
  "job": {
    "run": 12,
    "token": "…",
    "attempt": 1,
    "rule": { "name": "处理 issue", "cwd": "~/code/app" },
    "agent": { "id": "claude", "access": "edit" },
    "session": null,
    "context": { "events": [], "answers": [], "timers": [], "waiting": [], "open": [], "decided": [] },
    "thread": { "id": "处理 issue:owner/repo#42", "rounds": [], "related": [] }
  },
  "cancel": []
}
```

没有任务时 `job` 为 `null`。`cancel` 是本人要求停止的轮次。

### 报告开始

```http
POST /v1/runs/12/started
Authorization: Bearer <轮次 token>

{ "session": "…", "link": "claude://…" }
```

### 提交结果

```http
POST /v1/runs/12/result
Authorization: Bearer <轮次 token>

{
  "outcome": "done",
  "summary": "完成了",
  "session": "…",
  "usage": { "input": 1000, "output": 200, "cached": 500, "cost": 0.01 },
  "report": { "state": "ready", "note": "等审阅" },
  "ask": [],
  "notice": [],
  "resolve": [],
  "later": [],
  "events": []
}
```

`outcome`：`done`、`nothing`、`failed`、`cancelled`。重复提交同 token 同内容只确认一次；不同内容返回 409。

## 通道

### 领卡片

```http
GET /v1/cards/next?wait=50
Authorization: Bearer <channel-key>
```

响应 `{ "card": null | Card }`。卡片包含：

```json
{
  "id": 56,
  "version": 2,
  "ref": null,
  "kind": "ask",
  "state": "open",
  "title": "…",
  "text": "…",
  "options": ["…", "…"],
  "recommend": 0,
  "choice": null,
  "answer": null,
  "result": null,
  "link": null,
  "rule": "处理 issue"
}
```

### 报告送达或失败

```http
POST /v1/cards/56/delivered
{ "version": 2, "ref": "om_xxx" }

POST /v1/cards/56/failed
{ "version": 2, "error": "发送失败" }
```

`ref` 是通道自己的消息引用；支持更新的平台在卡片版本变化时更新原消息。

### 回答

```http
POST /v1/cards/56/answer
Authorization: Bearer <channel-key>

{ "choice": 1, "by": "ou_xxx", "ref": "om_xxx" }
```

`by` 必须在通道的 `answerers` 中（如果配置了）。`ref` 必须匹配该通道投递的引用。只有第一次回答生效。

HTTP 与 MCP 的 `choice` 是从 `0` 开始的下标；CLI `agent-autoloop answer <卡片> <序号>` 的序号从 `1` 开始，命令会先减一。

本人也可以直接回答：

```http
POST /v1/cards/56/answer
Authorization: Bearer <owner-key>

{ "choice": 1 }
```

### 结案

```http
POST /v1/cards/56/resolve
Authorization: Bearer <owner-key>

{ "reason": "已处理" }
```

## 本人

### 状态

```http
GET /v1/state
GET /v1/state?before=<轮次编号>
Authorization: Bearer <owner-key>
```

主要字段：

| 字段 | 说明 |
| --- | --- |
| `seq` | 当前日志序号，可用于 `/v1/stream?after=` |
| `now`、`timezone` | 当前时间和时区 |
| `spending` | 今天和最近 7 天的轮数、Token、费用 |
| `totals` | 运行、排队、重试、完成、未知等计数 |
| `cards`、`recentCards` | 待处理和最近卡片 |
| `timers` | 未到期复查 |
| `sources` | 来源和事件数 |
| `lines` | 规则、下次定时、统计、暂停 |
| `pauses`、`skipped` | 暂停和跳过事件 |
| `elsewhere` | 外部定时任务 |
| `agents`、`channels` | 在线状态 |
| `runs` | 最近轮次，默认 60 条 |
| `matters` | 活事项及阶段 |
| `decisions`、`mandates` | 最近 50 条审计 |
| `hasMore`、`nextBefore` | 分页 |
| `unrouted` | 没有匹配规则的事件 |

### 日志流

```http
GET /v1/stream?after=42
Authorization: Bearer <owner-key>
```

返回 `text/event-stream`：

```text
id: 43
event: fact
data: {"version":1,"seq":43,"at":...,"type":"...","changes":[...]}
```

也可用 `Last-Event-ID` 头续读。密钥被删除后流会关闭。

### 暂停、恢复、补跑、立即运行

```http
POST /v1/rules/<规则>/pause
{ "reason": "在改规则", "until": "2026-11-14T09:00:00+08:00" }

POST /v1/rules/<规则>/resume

POST /v1/rules/<规则>/replay
{ "since": "2026-11-13T10:00:00+08:00" }

POST /v1/rules/<规则>/run
{ "subject": "#42", "reason": "手动检查" }
```

暂停和立即运行互斥；暂停中调用 `run` 返回 409。

## 健康检查

```http
GET /healthz
```

```json
{ "ok": true, "commit": "17e6984" }
```

无需鉴权，适合反向代理和监控。不要暴露内部提交信息给不可信网络。

## 一致性与 schema

- 类型定义：`protocol/schema.json`；
- 校验器：`protocol/validate.ts`；
- 一致性检查：`agent-autoloop conformance <地址> --config <凭据文件>`；
- 凭据文件：

```json
{
  "keys": { "source": "…", "worker": "…", "channel": "…", "owner": "…" },
  "eventType": "probe.event",
  "answerer": "probe-user"
}
```

一致性检查会写事件和卡片，只能对专用测试中台运行。

## 客户端建议

- 用 `/v1/state` 的 `seq` 接 `/v1/stream?after=`，不要轮询全量；
- 分页用 `nextBefore`；
- 不要依赖未写入协议的内部字段；
- 忽略不认识的新字段，保证向前兼容；
- 卡片回答要处理“第一次有效”和 409；
- 长轮询超时是正常返回，不是错误。
