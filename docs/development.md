# 开发指南

本文面向修改内核、协议、插件和测试的维护者。用户操作见 [使用指南](usage.md)，架构见 [architecture.md](architecture.md)。

## 环境

- Node.js 24 或更新；
- Git；
- 不需要运行时依赖；
- 开发依赖：TypeScript、Prettier、Node 类型。

```bash
npm ci
npm run typecheck
npm run format:check
```

## 目录

```text
kernel/       决策、事实、投影、规则、到期、HTTP 行为、卡片表单
host/         运行外壳、SQLite、配置、服务、插件加载
protocol/     类型、schema、校验、客户端、一致性检查
worker/       接单、进程、心跳、停止、回执
cli/          用户命令
plugins/      内置 Agent、通道、来源、交付
examples/     模板和场景
skills/       面向 Agent 的操作手册
tests/        行为测试
sim/          模拟、穷举、强杀、变异
scripts/      性能、真机、安装冒烟
docs/         文档
```

## 内核边界

`kernel/` 只做四件事：**收、分、派、记**。

必须保持：

- 不读系统时钟；时间由调用方传入；
- 不取随机数；需要随机值时由外壳提供；
- 不访问网络；
- 不读写文件（卡片表单等纯函数除外）；
- 不知道具体产品名；
- 不导入 `host/`、`worker/`、`cli/`、`plugins/`；
- 同一输入和同一视图产生同样事实。

`tests/purity.test.ts` 守护这些约束。新增外部能力放在 `host/` 或插件。

## 修改流程

1. 先读 [protocol.md](protocol.md)、[state-machines.md](state-machines.md) 和相关测试；
2. 写能复现失败的测试；测试文件开头说明它防的失败；
3. 改实现；
4. 同步文档、schema 和兼容说明；
5. 运行验证；
6. 检查旧路径、旧名称、旧数量是否还有引用。

修 bug 先写失败测试，不为迁就实现改预期。

## 测试体系

| 命令 | 内容 |
| --- | --- |
| `npm run test:quick` | 除完整模拟外的测试 |
| `npm test` | 全部测试，含 20 万步模拟和穷举 |
| `npm run test:sim` | 2 万步随机模拟 |
| `npm run test:deep` | 强杀、变异等深测 |
| `npm run test:nightly` | 深测 + 性能 |
| `npm run benchmark` | 性能实测 |
| `npm run test:windows` | Windows 原生检查 |
| `npm run typecheck` | 类型检查 |
| `npm run format:check` | 格式检查 |

测试使用临时 `AGENT_AUTOLOOP_HOME`、随机端口、本地假 HTTP 和假通知命令。不要连接真实业务系统、发送真实消息或给在线飞书应用再开监听。

## 仿真与穷举

- `sim/random.ts`：随机事件、断网、丢包、崩溃、重复提交；
- `sim/crash.ts`：强杀进程，验证已确认事实不丢；
- `sim/enumerate.ts`：有界穷举；
- `sim/invariants.ts`：模拟和穷举共用的不变量；
- `sim/mutate.ts`：变异测试，确认测试能抓到错误。

改动 `kernel/`、`protocol/`、`sim/` 后：

```bash
npm test
npm run test:nightly
```

涉及日志、到期表或并发时也必须跑夜间检查。

## CI

`.github/workflows/check.yml`：

- Ubuntu、macOS、Windows；
- 文档改动跳过全部；
- 普通代码跑快速测试、类型、格式和安装冒烟；
- 内核改动额外跑 2 万步模拟；
- 特定模拟文件跑完整检查。

`.github/workflows/nightly.yml`：

- 20 万步模拟；
- 穷举；
- 强杀；
- 变异；
- 最新 Node；
- 安装冒烟。

`scripts/ci-scope.sh` 按改动范围决定跑多少。让测试读取某份文档时，要同步修改这个脚本。

## 协议变更

改协议必须同时：

1. 修改 `docs/protocol.md`；
2. 修改 `protocol/schema.json`；
3. 修改 `protocol/validate.ts`；
4. 修改或新增行为测试；
5. 写兼容说明；
6. 检查旧客户端和旧插件是否仍能运行。

新增字段优先可选；删除字段要走废弃周期。`/v1` 路径或字段语义破坏性变更才升主协议版本。

## 规则变更

改 `rules.json` 字段必须同步：

- `protocol/rules.ts` 校验器；
- `docs/configuration.md`；
- `docs/protocol.md` 规则示例；
- `README.md` 和 `README.en.md`（如果面向用户）；
- `skills/agent-autoloop/SKILL.md`（如果操作方式变化）；
- 相关测试和示例。

未知字段会被拒绝，新增字段必须加入校验器，否则用户无法使用。

## 插件变更

- 新插件放在 `plugins/<name>/`；
- 第三方插件自包含；
- 不反向导入内核；
- 新增 Agent 字段要可选；
- 通道要处理 `ref` 更新和失败报告；
- 来源要验签并返回稳定 id；
- 同步 [plugins.md](plugins.md) 和模板。

## 文档

- 面向用户的文字用中文大白话；
- 代码注释用英文，只写代码看不出来的原因；
- 文档不复制协议全文，链接权威来源；
- 示例必须能运行或明确标注占位；
- 新增文档要加入 [docs/README.md](README.md)；
- 修改命令、字段、路径时全局搜索旧值。

## 发布

- 版本号只写在 tag 上；
- `v1.2.3`；
- 安装和更新跟随最新 Release；
- 发布前跑完整检查；
- 发布说明写清行为变化和兼容性；
- 不修改已发布 tag。

## 提交与审查

- 一个 PR 解决一个问题；
- 外部 PR 尽量合并，维护者可直接在对方分支修正；
- 修 bug 提交写 `Fixes #编号`；
- 合并前确认 Ubuntu、macOS、Windows 检查通过；
- 不提交密钥、数据库、运行输出或敏感日志；
- 代码按 MIT 许可证提交。

## 常见陷阱

- 在 `kernel/` 里读时钟或随机数，破坏确定性；
- 在 `kernel/` 里导入插件或产品名；
- 只改校验器不改文档，用户看不到新字段；
- 只改协议不改 schema，客户端校验失败；
- 在 `evolve` 之外写投影；
- 在回执里加入未登记字段，旧中台拒收整份回执；
- 用 `access: "read"` 当系统沙箱；
- 认为 `done` 等于事项结束；
- 认为 `delivery=success` 等于一定上线；
- 认为 `project` 是多租户隔离。
