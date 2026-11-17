# 实现映射

本文把设计概念映射到当前代码，帮助维护者快速定位。字段和行为的权威说明仍以 [configuration.md](configuration.md)、[protocol.md](protocol.md) 和 [state-machines.md](state-machines.md) 为准。

## 目录与职责

| 路径                                                 | 职责                                     |
| ---------------------------------------------------- | ---------------------------------------- |
| `bin/agent-autoloop.ts`                              | CLI 启动入口                             |
| `cli/main.ts`                                        | 命令解析与用户操作                       |
| `cli/status.ts`、`cli/runs.ts`、`cli/why.ts`         | 状态、轮次和历史展示                     |
| `cli/mcp.ts`                                         | stdio MCP 服务                           |
| `cli/backup.ts`、`cli/compact.ts`、`cli/update.ts`、`cli/uninstall.ts` | 备份恢复、日志压缩、更新、卸载 |
| `host/up.ts`                                         | 单进程启动中台、worker 和通道            |
| `host/runtime.ts`                                    | 打开数据库、加载规则、执行决策、状态查询 |
| `host/server.ts`                                     | 时钟、规则文件监听、长轮询唤醒、日志流   |
| `host/http.ts`                                       | Node HTTP 到 Web Request 的适配          |
| `host/state.ts`                                      | `/v1/state` 的只读汇总                   |
| `host/plugins.ts`                                    | 插件发现与加载                           |
| `host/channels.ts`                                   | 通道类型和加载                           |
| `host/service.ts`                                    | launchd / systemd / Windows 登录任务     |
| `kernel/decide.ts`                                   | 所有输入如何变成事实                     |
| `kernel/store.ts`                                    | 事务、日志追加、投影提交                 |
| `kernel/evolve.ts`                                   | 事实应用与投影持久化                     |
| `kernel/query.ts`                                    | 读模型、Job 组装、线程召回               |
| `kernel/stage.ts`                                    | 事项阶段推导                             |
| `kernel/http.ts`                                     | HTTP 路由与门面行为                      |
| `kernel/due.ts`                                      | 到期索引                                 |
| `kernel/cron.ts`                                     | cron 解析和下次运行                      |
| `protocol/validate.ts`                               | 事件、回执、卡片输入的校验               |
| `protocol/rules.ts`                                  | `rules.json` 校验与默认值                |
| `protocol/schema.json`                               | 协议 JSON Schema                         |
| `worker/worker.ts`                                   | 接单、进程管理、心跳、停止、回执提交     |
| `worker/contract.ts`                                 | 提示词、回执解析、结果组装               |
| `worker/agents.ts`                                   | Agent 适配器接口和程序查找               |
| `plugins/*`                                          | 内置实现                                 |
| `examples/*`                                         | 可运行模板与场景                         |
| `tests/`                                             | 行为规格                                 |
| `sim/`                                               | 随机模拟、穷举、强杀、变异               |

## 概念映射

| 概念     | 数据 / 函数                                          | 说明                         |
| -------- | ---------------------------------------------------- | ---------------------------- |
| 事件     | `events` 表、`recordEvent`、`parseEvent`             | 来源 + key 去重              |
| 规则匹配 | `kernel/rules.ts` 的 `typeMatches`、`eventRule`      | 支持 `*` 和 `前缀.*`         |
| 事项     | `rule + lane`                                        | 没有单独表                   |
| 轮次     | `runs` 表、`enqueue`、`claimNext`、`finish`          | 状态机见文档                 |
| 回执     | `worker/contract.ts`、`parseResult`                  | 最后一条消息解析             |
| 卡片     | `cards`、`cardFromReceipt`、`answer`、`resolve`      | 提问和通知                   |
| 投递     | `deliveries`、`nextCard`、`delivered`、`failed`      | 版本与重试                   |
| 阶段     | `kernel/stage.ts` 的 `stageOf`                       | 只读派生                     |
| 决定     | `decisions`、`recordDecision`、`ensureDecision`      | 事件 × 规则                  |
| 授权     | `mandates`、`recordMandate`                          | 真正派发时写                 |
| gate     | `admit`                                              | 确定性准入                   |
| 研判     | `kind: "assess"`、`assessPrompt`、`applyVerdict`     | 普通 Agent 轮次              |
| 预演     | `kind: "speculate"`、`speculateWords`                | 值得才转正式轮               |
| 调度     | `kind: "dispatch"`、`dispatchSnapshot`、`applyRoute` | 只读翻译层，模型给 `route`、`create` 或带 `fyi` 的直接回复 |
| 项目创建 | `project_creations`、`pendingCreations`、`applyCreation` | 内核提议，宿主写配置 |
| 别名路由 | `byAlias`、`rule.aliases`                            | 确定性优先，不走模型         |
| 扇出     | `fanOut`、`policy.fanout`                            | 只加上下文                   |
| 线程召回 | `Job.thread`、`threadOf`                             | 稳定引用                     |
| 多项目   | `project` 校验时派生 `group` / `cwd`                 | 不是运行时隔离               |
| 通道风格 | `styleOf`、`styleWords`                              | `im` / `async`               |
| 暂停     | `pauses`、`pauseRule`、`resumeRule`                  | 事件不排队                   |
| 补跑     | `replayRule`、`skippedOf`                            | 只补暂停跳过的               |
| 日志流   | `logAfter`、`logStream`                              | SSE，本人密钥                |
| 历史查询 | `why`、`runs`、`/v1/state?before=`                   | 按轮次和分页                 |

## 轮次类型

| `kind`            | 触发                                 | 权限        | 结果用途                         |
| ----------------- | ------------------------------------ | ----------- | -------------------------------- |
| 普通（无 `kind`） | 规则命中、定时、回答、复查、手动运行 | 规则配置    | 正式工作                         |
| `assess`          | `policy.accept: "assess"`            | 强制 `read` | 提交 `verdict`，决定是否派正式轮 |
| `speculate`       | `speculate: true`                    | 强制 `read` | 回执 `report` 决定是否转正式轮   |
| `dispatch`        | `policy.dispatch`，任务事件未匹配    | 强制 `read` | 回执 `route`、`create` 或 `fyi` 回复，由中台复核后派发/回话/建项目 |

研判、预演和调度都按排队时的 Agent 领取，规则重载不改派。研判和预演只结算真正接下的事件；调度轮一轮只读一个事件，扇出上下文不作为授权依据。调度轮使用保留内部规则名 `__dispatch__`，不会与用户规则重名；对外显示为「调度」。调度成功、直接回复和未分配卡片都继承原事件 `reply`，并写 `dispatch_decisions`；本人纠正另写 `dispatch_corrections` 和 `dispatch_preferences`，下次快照可读。

调度提议新建项目时，内核只写 `project_creations`，事件进入 `creating`。事实提交后，宿主在 `queueMicrotask` 中调用 `pendingCreations` 和 `applyCreation`，由 `host/projects.ts` 原子写入 `rules.json` 与可选的 Activity 配置。成功写 `projectCreated` 并把事件重新排入调度；失败写 `projectCreationFailed` 并回到未分配卡片。新规则继承事件的来源和类型，`create.confidence` 低于 `minConfidence`、项目重复、目录不合法、节点不在 `workers` 白名单时都不会写配置。

## 决策顺序

外部事件进入时大致按以下顺序：

1. 校验事件；
2. 去重；
3. 检查 `hops`；
4. 匹配规则；
5. 排除暂停规则；
6. 对每条匹配规则计算 `admit`；
7. 记录事件和决定；
8. 若 `accept: "assess"`，排研判轮而不是正式轮；
9. 若规则 `speculate`，排预演轮而不是正式轮；
10. 若没有匹配，先按 `when.subjects` / `aliases` 做确定性路由；
11. 仍未放置且配置 `policy.dispatch`，为这个事件单独排一轮 `dispatch`；
12. 调度回执经 `applyRoute` 复核后，走与普通事件相同的 `placeEvent` / `dispatch`；若回执是 `create`，只记 `project_creations` 待办，由宿主写配置后重新调度；
13. 真正派发后写授权、标记 `routed`，按需扇出。

内部事件（回答、定时、复查、补跑、手动运行）没有独立 gate：真正派发时补一条 `accept` 决定，已有接受决定则不重复。

调度只处理真正未匹配的任务外部事件；通知、回答、定时和手动运行不进入。被 Policy 拒绝、超过 8 层、项目正在等本人处理（`person/blocked` / `person/failed`）时都不会强行派活。别名路由同样受事项阻塞约束。没有项目提示的外部提交使用会话级 subject，调度放到项目后再规范为 `<会话>/<项目>`，避免两个项目共享上下文。

## 事实与投影

- `facts`：只追加事实；
- `projections`：按集合和 key 存投影行；
- `projection_meta`：记录序号、编号高水位和格式指纹；
- `projection_refs`：行与事实的对应，供 `why` 使用；
- `projection_pending`：投递相关的待处理索引。

`kernel/evolve.ts` 负责应用事实；`kernel/store.ts` 负责事务和提交；`host/runtime.ts` 在启动时打开投影，格式变化时重建。不要在其他地方直接写投影。

## HTTP 门面

`kernel/http.ts` 定义路由和鉴权：

- `/v1/events`：来源写入；
- `/v1/work`：worker 长轮询；
- `/v1/cards/*`：通道领取、投递、回答、结案；
- `/v1/state`、`/v1/stream`：本人读取；
- `/v1/rules/*`：暂停、恢复、补跑、立即运行；
- `/healthz`：健康检查。

路由本身不做业务决策，只调用 `dispatch` 和查询函数。详细矩阵见 [api.md](api.md)。

## 插件加载

`host/plugins.ts`：

- 校验插件名；
- 先找 `HOME/plugins/<name>/<kind>.ts`，再找内置 `plugins/<name>/<kind>.ts`；
- 动态导入默认导出；
- Agent 适配器缓存在 `worker/agents.ts`；
- 通道在 `host/up.ts` 中持续运行，失败后 30 秒重启。

来源插件只在中台收到 Webhook 时加载，用于翻译和验签，不常驻。

## 接单程序

`worker/worker.ts` 负责：

- 长轮询领活；
- 本地保存 `entry.json`、stdout、exit 文件；
- 启动独立进程组；
- 心跳、停止、恢复；
- 读取输出、修复回执、提交结果；
- 本地用量基线。

Agent 进程可以比 worker 活得更久；worker 重启后会从本地文件恢复跟踪。

## CLI 与状态

- `status` 读取 `/v1/state` 并渲染；
- `board` 从 `matters` 分组，优先显示 `person/*`；
- `decisions`、`mandates` 读取审计投影；
- `runs` 和 `why` 查历史；
- `check` 只校验规则文件，不打开中台；
- `rules explain` 只读本机规则，不连接中台；
- `emit --dry-run` 只预演路由。

## 兼容性落点

- `protocol/rules.ts` 对未知字段报错，新增字段必须同步校验器；
- `protocol/schema.json` 描述 HTTP 类型；
- 旧事件缺字段时读取处使用默认值；
- 旧插件忽略不认识的 Job 字段；
- 投影格式指纹变化时重建，不改写事实；
- 旧配置不写 `policy` 时走 `off`。

## 有意未做

- 没有 Web 面板或内置看板 UI；
- 没有内嵌模型 SDK；
- 没有数据迁移脚本；
- 没有多租户硬隔离；
- 没有自动修改规则；
- 没有内置浏览器桥接；
- 没有跨中台复制或高可用集群。
