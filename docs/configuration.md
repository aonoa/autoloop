# 配置手册

本文是 `config.json`、`rules.json` 和 `secrets.env` 的字段参考。默认值和校验规则以 `protocol/rules.ts`、`host/config.ts` 为准；HTTP 字段见 [protocol.md](protocol.md)。

## 文件位置

默认安装目录是 `~/.agent-autoloop`（Windows 为 `%USERPROFILE%\.agent-autoloop`）：

| 文件          | 作用                                       | 权限                           |
| ------------- | ------------------------------------------ | ------------------------------ |
| `config.json` | 本机身份：中台地址、worker、密钥、通道选项 | 0600                           |
| `rules.json`  | 来源、Agent、通道、规则、定时任务          | 普通配置，含密钥时也应限制     |
| `secrets.env` | Webhook 验签秘密，按环境变量加载           | 0600                           |
| `master.key`  | 派生轮次 token 和卡片链接                  | 0600，必须与 `hub.db` 一起备份 |
| `hub.db`      | 事实日志和投影                             | 0600                           |
| `plugins/`    | 本机安装的插件                             | 可信代码                       |
| `worker/`     | 本地执行记录和用量基线                     | 私有                           |
| `logs/`       | 服务日志                                   | 私有                           |

可用环境变量改变位置：

| 变量                           | 作用                                                 |
| ------------------------------ | ---------------------------------------------------- |
| `AGENT_AUTOLOOP_HOME`          | 整个安装目录                                         |
| `AGENT_AUTOLOOP_RULES`         | 规则文件路径，默认 `$AGENT_AUTOLOOP_HOME/rules.json` |
| `AGENT_AUTOLOOP_PUBLIC_URL`    | 覆盖 `hub.publicUrl`，用于卡片链接和反向代理         |
| `AGENT_AUTOLOOP_COMMIT`        | 覆盖版本显示中的提交                                 |
| `AGENT_AUTOLOOP_CONFORMANCE`   | `conformance` 的默认凭据文件                         |
| `AGENT_AUTOLOOP_SECRET_<来源>` | Webhook 验签秘密，来源名大写、`-` 换成 `_`           |

## `config.json`

这是本机在中台中的身份。一台机器可以只做中台、只接活，或两者都做。

```json
{
  "url": "http://127.0.0.1:3350",
  "hub": {
    "listen": "127.0.0.1:3350",
    "publicUrl": "https://agent.example.com"
  },
  "worker": {
    "name": "mac-mini",
    "key": "worker-key",
    "capacity": 2,
    "unreachable": ["/usr/bin/osascript", "-e", "display notification \"{text}\" with title \"Agent\""]
  },
  "channels": {
    "desktop": { "key": "channel-key" },
    "feishu": { "key": "feishu-key", "user": "ou_xxx" }
  },
  "source": { "name": "local", "key": "source-key" },
  "owner": "owner-key"
}
```

### 顶层字段

| 字段       | 必填 | 说明                                     |
| ---------- | ---- | ---------------------------------------- |
| `url`      | 是   | 本机访问中台的地址；工作机填远端中台地址 |
| `hub`      | 否   | 本机运行中台时才有                       |
| `worker`   | 否   | 本机接活时才有                           |
| `channels` | 否   | 本机运行的通道及选项                     |
| `source`   | 否   | 本机作为来源发事件时使用                 |
| `owner`    | 否   | 本人密钥；只有中台或管理机能看全局       |

### `hub`

| 字段        | 必填 | 说明                                                                                  |
| ----------- | ---- | ------------------------------------------------------------------------------------- |
| `listen`    | 是   | `主机:端口`；IPv6 用 `[地址]:端口`。只写端口或 `:端口` 会被拒绝，避免意外监听所有网卡 |
| `publicUrl` | 否   | 外部可达地址，用于卡片链接。默认由 `listen` 推导                                      |

监听非回环地址时，中台会向该网络开放，日志会提醒；公网部署必须在前方放 HTTPS 反向代理。

### `worker`

| 字段          | 必填                      | 默认                | 说明                                                      |
| ------------- | ------------------------- | ------------------- | --------------------------------------------------------- |
| `name`        | 手写时是；`init` 自动生成 | `init` 由主机名派生 | worker 身份，必须匹配 `[a-z][a-z0-9-]*`                   |
| `key`         | 是                        | 无                  | 接单密钥                                                  |
| `capacity`    | 否                        | `2`                 | 同时执行的最大轮数                                        |
| `unreachable` | 否                        | 无                  | 中台长时间不可达时执行的命令数组；`{text}` 替换为说明文字 |

`capacity` 是进程级上限，仍受规则组 `parallel`、规则 `maxActive` 和 Agent `maxActive` 约束。

### `channels`

每个键是 `rules.json` 中登记的通道 id：

```json
{
  "channels": {
    "feishu": { "key": "…", "user": "ou_xxx", "lark": "lark-cli" },
    "qq": { "key": "…", "appId": "…", "clientSecret": "…", "user": "USER_OPENID" },
    "insoulforge": {
      "key": "…",
      "activityUrl": "ws://127.0.0.1:7778/activities/ws",
      "activityToken": "…",
      "activityName": "autoloop-outbox",
      "fallback": "private:10001001"
    },
    "napcat": {
      "key": "…",
      "url": "http://127.0.0.1:3000",
      "ws": "ws://127.0.0.1:3000",
      "token": "…",
      "user": "QQ_NUMBER"
    },
    "desktop": { "key": "…" },
    "dingtalk": {
      "use": "webhook",
      "key": "…",
      "platform": "dingtalk",
      "url": "https://oapi.dingtalk.com/robot/send?access_token=…"
    }
  }
}
```

| 字段  | 说明                           |
| ----- | ------------------------------ |
| `key` | 通道密钥，必填                 |
| `use` | 插件名；不写时用通道 id        |
| 其他  | 原样传给通道插件作为 `options` |

`use` 让多个通道复用同一实现。例如 `rules.json` 里登记 `dingtalk`，`config.json` 里写 `"use": "webhook"` 和平台参数。

QQ 通道的选项：

| 字段           | 必填   | 说明                                                       |
| -------------- | ------ | ---------------------------------------------------------- |
| `appId`        | 是     | QQ 开放平台机器人的 AppID                                  |
| `clientSecret` | 是     | AppSecret；只放在 `config.json`，不要写进规则或日志        |
| `user`         | 二选一 | 收卡片的 QQ 用户 OpenID，单聊场景                          |
| `group`        | 二选一 | 收卡片的群 OpenID，群聊场景；不能和 `user` 同时写          |
| `api`          | 否     | 覆盖 OpenAPI 地址，默认 `https://api.bot.qq.com`，用于测试 |

QQ 通道用官方 Gateway WebSocket 收回消息和按钮点击，不需要公网回调地址。一个通道实例只投递到一个用户或一个群；`user` 和 `group` 都不写或都写时会拒绝发送并报告失败，不会猜目标。`rules.json` 的 `answerers` 应填对应的 OpenID，点击回答会带上平台提供的身份。

NapCat 通道走 OneBot 11，适合已经用 NapCat 登录 QQ 账号的场景。它和上面的官方 QQ Bot 是两个独立插件；通道 id 可以叫 `napcat`，也可以写 `"use": "napcat"` 复用实现。

| 字段    | 必填   | 说明                                                           |
| ------- | ------ | -------------------------------------------------------------- |
| `url`   | 是     | NapCat 的 OneBot HTTP 地址，例如 `http://127.0.0.1:3000`       |
| `ws`    | 是     | OneBot 正向 WebSocket 地址，例如 `ws://127.0.0.1:3000`         |
| `token` | 否     | OneBot access token；配置了就同时用于 HTTP 和 WebSocket        |
| `user`  | 二选一 | 兜底收件 QQ 号；没有来源会话的卡片发到这里                     |
| `group` | 二选一 | 兜底收件群号；没有来源会话的卡片发到这里，不能和 `user` 同时写 |

NapCat 直连通道用 HTTP 发送，用 WebSocket 收回消息。QQ 普通消息没有官方 Bot 那样的回调按钮，所以卡片以文字编号发出；引用卡片消息后回复 `#1`、`#2` 才会算作回答。只有一张卡片在等时可以不带引用直接回编号，有多张时必须引用，通道不会猜是哪一张。`rules.json` 的 `answerers` 填 QQ 号。

官方 QQ Bot、NapCat 和 `qq-source` 是保留的可选直连插件，适合不让机器人参与收发的部署。它们不会因为启用 InSoulForge 而删除；两者的区别只是本机是否启用对应通道。

### QQ（经 InSoulForge 机器人回投，`insoulforge`）

聊天、任务接收和结果通知都走 InSoulForge 时，用 `insoulforge` 回投通道。它不直接连接 NapCat，而是把中台的卡片通过 Activity `notify` 发回机器人，让机器人决定是否转告、追问或继续派任务。

| 字段            | 必填 | 说明                                                                |
| --------------- | ---- | ------------------------------------------------------------------- |
| `activityUrl`   | 是   | InSoulForge Activity 地址，例如 `ws://127.0.0.1:7778/activities/ws` |
| `activityToken` | 是   | InSoulForge 后台配置的 Activity Token                               |
| `activityName`  | 否   | 回投服务名，默认 `autoloop-outbox`；不能和收任务的 Activity 同名    |
| `heartbeatMs`   | 否   | 心跳间隔，默认 `20000`；必须小于 InSoulForge 的 45 秒空闲上限       |
| `fallback`      | 否   | 无来源会话卡片的收件人，写成 `private:<QQ号>` 或 `group:<群号>`     |

带 `reply` 的卡片回原私聊或原群；`fallback` 只用于 GitHub、定时任务、中台告警等没有 QQ 来源的卡片。启用本通道时不要同时启用 `napcat` 和 `qq-source`，否则同一条 QQ 消息会被两个入口消费。这里的“不要同时启用”指本机运行配置，不要求删除 `plugins/qq`、`plugins/napcat` 或 `plugins/qq-source`。

完整部署步骤见 [`integrations/insoulforge/README.md`](../integrations/insoulforge/README.md)。

### QQ 任务来源（`qq-source`，可选直连）

`qq-source` 也是一个通道配置项，但它的职责是**收任务**，不是发卡片。它连 NapCat 的正向 WebSocket，把允许名单里的私聊文字、以及允许群里指定成员的文字变成 `qq.task` 事件；结果仍由同一份配置里的 `napcat` 通道发回原会话。

```json
"channels": {
  "qq-source": {
    "use": "qq-source",
    "key": "qq-source 自己的通道密钥",
    "url": "http://127.0.0.1:3350",
    "ws": "ws://127.0.0.1:3001",
    "token": "NapCat access token",
    "sourceKey": "来源密钥",
    "allowed": ["本人 QQ 号"],
    "groups": ["允许派任务的群号"],
    "bot": "专用 QQ 号"
  },
  "napcat": {
    "key": "napcat 通道密钥",
    "url": "http://127.0.0.1:3001",
    "ws": "ws://127.0.0.1:3001",
    "token": "NapCat access token",
    "user": "本人 QQ 号"
  }
}
```

| 字段        | 必填 | 说明                                    |
| ----------- | ---- | --------------------------------------- |
| `url`       | 是   | 中台地址，用于 `POST /v1/events`        |
| `ws`        | 是   | NapCat 正向 WebSocket 地址              |
| `token`     | 否   | OneBot access token，和 NapCat 通道共用 |
| `sourceKey` | 是   | 来源密钥；只能提交事件，不要交给 Agent  |
| `allowed`   | 是   | 允许派任务的 QQ 号，不能为空            |
| `groups`    | 否   | 允许派任务的群号；不写则不收群任务      |
| `bot`       | 否   | 专用 QQ 号；用来排除机器人自己的回显    |

`allowed` 是硬门槛：不在名单里的私聊或群发言都不会产生事件。`groups` 是群任务的门槛：只收名单里那些群的消息。`rules.json` 里对应来源还可以再写 `policy.allowlist`，形成第二道校验。

NapCat 通道的 `user` 是**兜底收件人**，只用于没有来源会话的卡片（例如非 QQ 来源的任务、中台自己的告警）。带 `reply` 的卡片发回原会话：`qq-private-<QQ号>` 回私聊，`qq-group-<群号>` 回群。同一个 NapCat 通道可以同时服务私聊和群，不需要配多个通道。

群卡片由 `rules.json` 里该通道的 `answerers` 决定谁能回答；私聊卡片只有收到它的人能回答。单独一个 `#N` 保留为卡片回答。规则必须同时匹配 `qq.task` 和 `card.answered`，否则回答后不会继续。完整示例见 [`examples/qq-private/`](../examples/qq-private/README.md)。

#### 同一个群里的多个项目

一个群里可以同时谈几个互不相关的项目。消息开头写 `/项目短名`，这一段就会从这个群的事项里再分出一层 lane：

```text
/shop 结算页报错，看一下
/site 首页图片加载慢
/shop 刚才那个问题修好了吗？
```

对应的 `subject` 依次是 `qq-group-<群号>/shop`、`qq-group-<群号>/site`、`qq-group-<群号>/shop`。规则要同时写：

```json
{ "parallel": 4, "resume": true }
```

`parallel` 让不同 `subject` 各自成一个事项，可以分别排队和并发；`resume` 让同一事项的下一轮接着上一轮的 Agent 会话。于是 `/shop` 和 `/site` 各自有历史，不会把另一个项目的前提带进来。没有项目前缀的消息仍归整个群，共用群这一层的上下文。

项目短名只能用字母、数字、`.`、`_`、`-`，最长 40 个字符；它必须是 `/项目短名` 后紧跟空格再接任务，单独一个 `/shop` 只是普通文字。项目短名是事项标识，不是工作目录：Agent 在哪个目录、用哪些权限仍只由规则决定。卡片会带上所属 lane，回答沿用原 lane；两个项目同时等你拍板时，`#1` 只会回答对应会话里的卡片。

`resume` 的会话会随同一项目的对话持续增长。项目周期很长、历史很大时，定期换一个新的项目短名（例如 `/shop-2026q4`）或新建规则，比让一个会话无限变长更省 Token。

### `source` 与 `owner`

```json
"source": { "name": "local", "key": "…" },
"owner": "…"
```

- `source` 用于本机 CLI 发事件，`name` 是显示名，`key` 是来源密钥。
- `owner` 是本人密钥，用于看状态、回答、暂停、结案、日志流。
- 工作机可以没有 `owner`，因此不能看全局；这是有意的权限分离。

## `rules.json`

规则文件是可信配置。写错时：

- 启动阶段：中台拒绝启动并指出字段；
- 运行阶段：旧规则继续运行，并推一张卡片报告错误；
- 修改后几秒内生效；已领取的轮次保留领取时的规则快照。

### 顶层结构

```json
{
  "timezone": "Asia/Shanghai",
  "askFirst": ["删数据", "停服", "花钱", "对外发消息", "改产品方向", "新建或轮换密钥", "修改权限"],
  "sources": {},
  "agents": {},
  "channels": {},
  "policy": {},
  "rules": [],
  "elsewhere": []
}
```

| 字段              | 必填 | 默认     | 说明                                                                                             |
| ----------------- | ---- | -------- | ------------------------------------------------------------------------------------------------ |
| `timezone`        | 否   | 系统时区 | 定时和“今天”的时区，必须是有效 IANA 时区                                                         |
| `askFirst`        | 否   | 内置七类 | 要求 Agent 先问人的事项类别                                                                      |
| `sources`         | 是   | 无       | 来源登记                                                                                         |
| `agents`          | 是   | 无       | Agent 登记                                                                                       |
| `channels`        | 否   | `{}`     | 通道登记                                                                                         |
| `defaultChannels` | 否   | 无       | 没有自己指定通道的卡片默认发往这里；不写则发所有通道。若写，必须是非空列表，且每项都是已登记通道 |
| `policy`          | 否   | 无       | 全局准入策略                                                                                     |
| `rules`           | 是   | 无       | 规则列表                                                                                         |
| `elsewhere`       | 否   | `[]`     | 在别处运行的定时任务，仅展示和回答接续                                                           |

未知字段会被拒绝，避免拼写错误被静默忽略。

### `sources`

```json
{
  "sources": {
    "github": { "name": "GitHub", "adapter": "github" },
    "shop": {
      "name": "商店",
      "adapter": "shop",
      "policy": {
        "allowlist": ["alice"],
        "admission": "named",
        "bots": ["dependabot"]
      }
    },
    "local": { "name": "本机" }
  }
}
```

| 字段      | 必填 | 说明                                                    |
| --------- | ---- | ------------------------------------------------------- |
| `name`    | 是   | 显示名                                                  |
| `adapter` | 否   | Webhook 翻译插件名；不写时来源只能直接调用 `/v1/events` |
| `policy`  | 否   | 来源级准入策略                                          |

来源 id 必须匹配 `[a-z][a-z0-9-]*`。`schedule` 是保留 id，不能手动登记；定时规则使用 `when.cron`。

来源 `policy`：

| 字段        | 默认  | 说明                                           |
| ----------- | ----- | ---------------------------------------------- |
| `allowlist` | 无    | 允许的身份列表；空数组表示来源放行的人都可以   |
| `admission` | `any` | `named` 要求点名 Agent；`any` 不要求           |
| `bots`      | 无    | 允许的机器人身份；不受 allowlist 和 named 限制 |

### `agents`

```json
{
  "agents": {
    "claude": {
      "name": "Claude Code",
      "worker": "mac-mini",
      "use": "claude",
      "model": "claude-sonnet-4-5",
      "effort": "high",
      "access": "edit",
      "timeout": 35,
      "maxActive": 2
    },
    "shell": {
      "name": "脚本",
      "worker": "mac-mini",
      "use": "command",
      "command": ["/usr/local/bin/my-agent", "--prompt", "{prompt}", "--context", "{context}"],
      "access": "read"
    }
  }
}
```

| 字段        | 必填                    | 默认     | 说明                                             |
| ----------- | ----------------------- | -------- | ------------------------------------------------ |
| `name`      | 是                      | 无       | 显示名，也用于 `admission: "named"` 匹配         |
| `worker`    | 是                      | 无       | 哪台接单机执行                                   |
| `use`       | 是                      | 无       | Agent 插件名；`command` 表示命令模板             |
| `model`     | 否                      | CLI 默认 | 传给插件                                         |
| `effort`    | 否                      | CLI 默认 | 推理强度，传给插件                               |
| `tier`      | 否                      | CLI 默认 | 服务档位；目前内置 Codex 使用                    |
| `access`    | 否                      | `edit`   | `read` / `edit` / `full`                         |
| `command`   | `use: "command"` 时必填 | 无       | 命令参数数组，不是 shell 字符串                  |
| `program`   | 否                      | 自动查找 | 内置插件启动的替代程序，如设置环境变量的包装脚本 |
| `timeout`   | 否                      | `180`    | 单轮超时，分钟；不写时 worker 按 180 分钟处理    |
| `maxActive` | 否                      | 无       | 该 Agent 跨规则同时执行的最大轮数                |

`command` 支持的占位符：

| 占位符      | 替换为           |
| ----------- | ---------------- |
| `{prompt}`  | 完整提示词       |
| `{model}`   | `model` 或空     |
| `{effort}`  | `effort` 或空    |
| `{cwd}`     | 工作目录         |
| `{context}` | 资料文件绝对路径 |

占位符替换是字面替换，不经过 shell；`{prompt}` 里出现的 `{cwd}` 不会被再次展开。

`access` 的实际效果取决于 Agent 插件，详见 [插件文档](plugins.md#access-实际能做什么)。

### `channels`

```json
{
  "channels": {
    "feishu": {
      "name": "飞书",
      "answerers": ["ou_xxx"],
      "links": true,
      "style": "im"
    },
    "qq": { "name": "QQ", "answerers": ["USER_OPENID"] },
    "napcat": { "name": "QQ（NapCat）", "answerers": ["QQ_NUMBER"] }
  }
}
```

| 字段        | 必填 | 默认    | 说明                                             |
| ----------- | ---- | ------- | ------------------------------------------------ |
| `name`      | 是   | 无      | 显示名                                           |
| `answerers` | 否   | 无      | 允许回答卡片的平台身份；不写时该通道内谁都能回答 |
| `links`     | 否   | `false` | 是否给卡片附可点击链接                           |
| `style`     | 否   | 无      | `im` 或 `async`，影响提示词写作风格              |

`answerers` 是身份白名单，不是密钥；真正的鉴权仍由通道密钥和平台回调校验完成。

### `policy`

```json
{
  "policy": {
    "accept": "gate",
    "assessor": "claude",
    "fanout": true,
    "dispatch": { "agent": "dispatcher", "minConfidence": 0.7 }
  }
}
```

| 字段       | 默认    | 说明                                               |
| ---------- | ------- | -------------------------------------------------- |
| `accept`   | `off`   | `off` / `gate` / `assess`                          |
| `assessor` | 无      | `assess` 时必填，必须是已登记 Agent                |
| `fanout`   | `false` | 事件真正派发后，是否把上下文扇出到同对象其他活事项 |
| `dispatch` | 无      | 未匹配事件的调度 Agent；不写则保持旧行为           |

校验规则：

- `accept: "assess"` 必须写 `assessor`；
- 写了 `assessor` 就必须 `accept: "assess"`；
- `assessor` 必须是 `agents` 中已登记的 id；
- `dispatch.agent` 必须是 `agents` 中已登记的 id；`minConfidence` 是 0 到 1 之间的数，默认 0.7；
- 只写 `fanout` 不会开启 gate。

#### 调度 Agent：`policy.dispatch`

没有规则匹配、也没有项目别名命中的外部事件，可以交给一个**只读的调度 Agent** 判断属于哪个项目：

```json
"policy": {
  "accept": "gate",
  "dispatch": {
    "agent": "dispatcher",
    "minConfidence": 0.7,
    "create": false,
    "workers": []
  }
}
```

行为：

- 只有**真正没有匹配**的外部事件才进入调度；命中规则、被 Policy 拒绝、超过 8 层的事件都不进。
- 先做确定性路由：项目 `when.subjects` 或 `aliases` 能匹配时直接派发，不问模型。
- 每个未分配事件单独排一轮 `kind: "dispatch"`，一轮只读一个事件；不会把多个事件合并后只处理第一个。
- 调度快照由中台事实生成：项目、规则、`cwd`、Agent、`worker`、在线状态、`subjects`、`aliases`、活跃事项和最近轮次。模型不记节点和项目。
- 项目规则的 `description` 是给调度 Agent 看的项目说明；项目最近一轮的状态、能否续接会话、上次调度结果和本人纠正偏好也一起进快照。
- 调度 Agent 返回 `route`：`project`、`session`（`continue` / `new` / `ask`）、`confidence`、`reason`；开启 `create` 后，也可以只提议新建项目。
- 不是任务的聊天、确认或道谢，可以只返回带 `"fyi": true` 的 `notice`，由中台直接回到原会话；不带 `fyi` 的 `notice` 不会被当作聊天回复，仍转成未分配卡片。
- 中台重新校验项目是否存在、来源和事件类型能否到达、发送人是否被来源允许、节点是否在线；任何一项不过都不派活。
- `session: "continue"` 取同项目、同 lane 最近一次成功会话；会话被其他 queued、claimed 或 unknown 轮次占着、没有会话或 Agent 变了，就安全地新开，不并入一个可能仍在运行的会话。`new` 强制新建独立轮次并清空会话；`ask` 发一张项目选择卡。
- 调度失败、没有 `route`、项目不合法或置信度不足时，生成“未分配”卡片，不会无限重试；失败本身仍记为 `dispatch_state: "failed"`，不会伪装成普通未分配。
- 调度成功会在原会话发一条“任务已分配”，说明放到了哪个项目；直接回复和未分配卡片也回到原会话。
- 项目正在等本人处理（`person/blocked`、`person/failed`）时，调度不能强行塞入新工作；确定性别名路由也遵守这条约束。

自动创建项目默认关闭。开启 `policy.dispatch.create: true` 后，调度 Agent 可以在确实没有合适项目时提交：

```json
{
  "create": {
    "project": "shop",
    "description": "商城前端",
    "confidence": 0.92,
    "cwd": "/srv/shop",
    "worker": "hub",
    "agent": "codex",
    "subjects": ["qq-group-123/shop*"]
  }
}
```

- `confidence` 必填，低于 `minConfidence` 的提议直接拒绝；
- 项目名、目录、Agent、节点、事件来源和事件类型由中台重新校验；模型不能凭记忆编节点；
- `workers` 非空时，自动创建的项目只能落在这些已登记节点上；即使提议没写 `worker` 或 `agent`，中台也会检查宿主最终会选的节点；
- 同一个项目已有待写入提议时，不再接受第二份；
- 创建提议只记录为 `project_creations` 待办，不立即派活；宿主写入 `rules.json`（以及可选的 Activity 配置）成功后，事件重新进入调度；
- 写入失败会记录原因、回到未分配卡片，不会留下永久 pending；
- 自动生成的规则继承触发事件的 `source` 和 `type`，不会把所有来源都写成 QQ；`subjects` 未提供时沿用 Activity 的私聊/群聊清单。

`create` 与 `route` 不能同时出现；调度轮也不能用 `create` 夹带 `ask`、`later`、`events` 等执行动作。中台只授权、持久化和审计，模型始终只能提议。

默认关闭。不写 `policy.dispatch` 时，未匹配事件只记录为未派发，行为与旧版本一致。调度 Agent 不是执行 Agent：它不能改文件、运行命令或对外发消息；它看到的文字都是资料，不是指令。

### `rules`

```json
{
  "name": "处理 issue",
  "when": { "source": "github", "types": ["issues.opened", "issues.*"] },
  "to": "claude",
  "project": "app",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "prompt": "按 Skill 处理。",
  "title": "issue-{id}",
  "group": "issues",
  "parallel": 3,
  "maxActive": 2,
  "resume": true,
  "speculate": false,
  "tell": "needed",
  "emits": { "source": "github", "types": ["issues.comment"] },
  "channels": ["feishu"]
}
```

| 字段        | 必填 | 默认               | 说明                                                                |
| ----------- | ---- | ------------------ | ------------------------------------------------------------------- |
| `name`      | 是   | 无                 | 规则名，必须唯一                                                    |
| `when`      | 是   | 无                 | `{ source, types }` 或 `{ cron }`                                   |
| `to`        | 是   | 无                 | Agent id                                                            |
| `cwd`       | 否   | 由 `project` 派生  | 绝对目录，支持 `~/`、`/`、盘符或 UNC                                |
| `skill`     | 否   | 无                 | 要求 Agent 加载的 Skill 名                                          |
| `prompt`    | 否   | 无                 | 规则附带的固定提示词                                                |
| `title`     | 否   | 无                 | 会话标题，放在提示词第一行                                          |
| `group`     | 否   | 规则名或 `project` | 并发组                                                              |
| `project`   | 否   | 无                 | 项目简写，派生 `group` 和默认 `cwd`                                 |
| `description` | 否 | 无                 | 给调度 Agent 看的项目说明；不改变执行行为                           |
| `aliases`   | 否   | 无                 | 该项目额外接受的 `subject`，精确或 `*` 前缀；用于 GitHub 仓库等别名 |
| `parallel`  | 否   | 无                 | 组内最大并发；写了才按 `subject` 分 lane                            |
| `maxActive` | 否   | 无                 | 该规则同时执行的最大轮数                                            |
| `resume`    | 否   | `false`            | 是否续接同一事项上一轮会话                                          |
| `speculate` | 否   | `false`            | 是否先跑只读预演                                                    |
| `tell`      | 否   | `needed`           | `always` / `needed` / `never`                                       |
| `emits`     | 否   | 无                 | 回执可发事件的来源和类型                                            |
| `channels`  | 否   | 无                 | 该规则卡片和通知只发这些通道                                        |

`when` 两种形式：

```json
{ "source": "github", "types": ["issues.opened", "issues.*"] }
{ "cron": "0 9 * * *" }
```

- `types` 至少一项；支持 `*`、精确类型和 `前缀.*`；
- `subjects` 可选：按事件的 `subject` 收窄规则，写精确值或前缀加 `*`（如 `qq-group-123/shop*`）；不写表示不限。
  同一个来源要按项目拆规则时，用它让每个项目只接自己的 lane，而不是让每条规则都收到同一事件。
- cron 是标准五段式，时区由顶层 `timezone` 决定；
- 定时规则的事件来源是保留的 `schedule`。

`title` 约束：

- 字母或数字开头；
- 不含空白；
- 只能使用 `{id}` 和 `{subject}` 占位符；
- `{id}` 取这一轮共同 `subject` 按 `/ # :` 分开的最后一段。

`tell`：

| 值       | 行为                                     |
| -------- | ---------------------------------------- |
| `always` | 每轮做成后都通知；没事可做或没跑成不通知 |
| `needed` | 只在有卡片时通知（默认）                 |
| `never`  | 只压住回执里的通知；提问和中台告警照发   |

`project` 校验：

- 只能使用字母、数字和 `. _ -`；
- 未写 `group` 时取 `project`；
- 未写 `cwd` 时派生 `~/<project>`；
- 它不改变派工权限，只是命名和分组简写。

`description` 是项目的一句话说明，只在调度快照里给调度 Agent 读。外部系统不必知道项目规则和 `cwd`；它们只提交任务，调度 Agent 根据说明、别名、最近会话和本人纠正记录选项目。它不是权限声明，也不是提示词指令，项目能否接单仍由来源 Policy、节点和事项阶段决定。

`aliases` 只参与**确定性路由**：当事件没有命中任何规则时，若某个项目的 `aliases` 或 `when.subjects` 匹配事件 `subject`，就把它直接放进该项目，不再询问调度 Agent。别名仍要经过来源 Policy、节点在线和事项阻塞检查；它不是绕过授权的入口。

### `elsewhere`

用于在 Claude 应用等外部系统运行的定时任务。中台不启动、不记录这些任务，只展示，并可在任务向中台提问后接续回答。

```json
{
  "name": "每周清理",
  "source": "local",
  "to": "claude",
  "cron": "0 6 * * 0",
  "where": "Claude 应用的定时任务",
  "model": "claude-sonnet-4-5",
  "effort": "high",
  "cwd": "~/code/app",
  "skill": "weekly-sweep",
  "prompt": "回答来了就按这一节处理。"
}
```

| 字段              | 必填 | 说明                 |
| ----------------- | ---- | -------------------- |
| `name`            | 是   | 唯一，不能与规则重名 |
| `source`          | 是   | 已登记来源           |
| `to`              | 是   | 已登记 Agent         |
| `cron`            | 是   | 五段式               |
| `where`           | 是   | 展示在哪个应用运行   |
| `model`、`effort` | 否   | 仅展示               |
| `cwd`             | 否   | 回答后接续的工作目录 |
| `skill`、`prompt` | 否   | 回答后照什么做       |

写了 `skill` 或 `prompt` 就必须写 `cwd`。写了 `cwd` 但没写 `skill`/`prompt` 时，只有 `command` 类 Agent 允许。

## `secrets.env`

用于 Webhook 验签：

```dotenv
AGENT_AUTOLOOP_SECRET_GITHUB=your-github-webhook-secret
AGENT_AUTOLOOP_SECRET_GITLAB=your-gitlab-token
AGENT_AUTOLOOP_SECRET_SHOP=your-shop-secret
```

来源 id 转大写、`-` 换成 `_`。例如来源 `my-shop` 对应 `AGENT_AUTOLOOP_SECRET_MY_SHOP`。

修改后重启中台。秘密不会进入 `rules.json`，但仍会出现在备份中，备份需按密钥保管。

## 校验与热加载

```bash
agent-autoloop check                 # 检查默认 rules.json
agent-autoloop check draft.json      # 检查草稿
agent-autoloop rules explain         # 查看本机生效规则
agent-autoloop emit demo.start --dry-run  # 预演事件路由
```

`check` 不连接中台、不打开数据库；`rules explain` 和 `emit --dry-run` 只读本机文件。

运行中修改 `rules.json`：

- 几秒内重新加载；
- 写错时保留旧规则，并推卡片说明错误；
- 排队中的轮次在领取时使用最新规则；
- 已领取的轮次保留领取时的规则快照和 worker。

QQ 项目还有第二份配置：InSoulForge Activity 的 `activity.json`，其中 `projects` 决定机器人能显式提示哪些项目，`allow.private` / `allow.groups` 决定允许的会话。它是可选的提示表，不是外部必须掌握的路由表：拿不准时可以省略 `project_hint`，交给调度 Agent。不要分别手改两份文件；用 `agent-autoloop project add` 一次更新规则、项目说明和 `subjects`。Activity 服务也会监听这份文件，合法修改后重连并重新注册，不需要重启；写错时保留旧配置并记录日志。详见[使用手册](usage.md#动态添加项目)。

## 配置模式

### 最小单机

```json
{
  "sources": { "local": { "name": "本机" } },
  "agents": {
    "agent": { "name": "Agent", "worker": "this-machine", "use": "codex" }
  },
  "channels": { "desktop": { "name": "桌面通知" } },
  "rules": [
    {
      "name": "试一下",
      "when": { "source": "local", "types": ["try.*"] },
      "to": "agent",
      "cwd": "~/.agent-autoloop/try",
      "prompt": "只读资料，回答一个问题。"
    }
  ]
}
```

### 多项目（`rules` 片段）

下面是 `rules.json` 中 `rules` 数组的片段，不是可直接解析的完整顶层配置；使用时要和 `sources`、`agents` 等字段放在同一份完整 `rules.json` 中。

```json
{
  "rules": [
    {
      "name": "app issue",
      "when": { "source": "github", "types": ["issues.opened"] },
      "to": "claude",
      "project": "app",
      "group": "app-issues",
      "parallel": 2
    },
    {
      "name": "web issue",
      "when": { "source": "github", "types": ["issues.opened"] },
      "to": "codex",
      "project": "web",
      "group": "web-issues",
      "parallel": 2
    }
  ]
}
```

两个项目共享中台，但 `cwd`、`group` 和并发分开。它们仍共享事实库和密钥体系。

### 治理开启

```json
{
  "policy": { "accept": "assess", "assessor": "judge", "fanout": true },
  "sources": {
    "github": {
      "name": "GitHub",
      "adapter": "github",
      "policy": { "allowlist": ["alice", "bob"], "admission": "named", "bots": ["dependabot"] }
    }
  },
  "agents": {
    "judge": { "name": "Judge", "worker": "this-machine", "use": "claude", "access": "read" },
    "worker": { "name": "Worker", "worker": "this-machine", "use": "codex" }
  },
  "rules": [
    {
      "name": "处理 issue",
      "when": { "source": "github", "types": ["issues.opened"] },
      "to": "worker",
      "cwd": "~/code/app",
      "prompt": "按 Skill 处理。"
    }
  ]
}
```

## 常见错误

| 错误                                          | 原因                       |
| --------------------------------------------- | -------------------------- |
| `hub.listen 要写成 主机:端口`                 | 只写了端口或 `:端口`       |
| `缺少 cwd（也可以写 project）`                | 两者都没写                 |
| `组「…」里的规则 parallel 要一致`             | 同组规则并发不一致         |
| `policy 写了 accept: assess，还要写 assessor` | 缺研判 Agent               |
| `assessor 不是已登记的 Agent`                 | id 写错或未登记            |
| `有不认识的字段`                              | 拼写错误或使用了未实现字段 |
| `规则名「…」重复了`                           | 规则名不唯一               |
| `title 要是字母或数字开头、不含空白的一个词`  | 标题不满足会话命名约束     |

更多运行时错误见[运维手册](operations.md#故障排查)。
