# 文档总览

这里把 Agent Autoloop 的**运行原理、配置方法、扩展契约和运维边界**分开说明。先读哪篇，取决于你要做什么。

## 按目标阅读

| 我想…… | 先读 | 再读 |
| --- | --- | --- |
| 第一次装起来并跑通 | [安装说明](../INSTALL.md) | [使用指南](usage.md) |
| 写规则、接来源、接通道 | [配置手册](configuration.md) | [使用指南](usage.md) |
| 理解系统为什么这样设计 | [架构文档](architecture.md) | [设计文档](design.md) |
| 自己写 Agent / 通道 / 事件插件 | [插件开发](plugins.md) | [协议](protocol.md) |
| 对接 HTTP、做看板或 MCP 客户端 | [API 速查](api.md) | [协议](protocol.md) |
| 部署到服务器、备份和排障 | [运维手册](operations.md) | [安全模型](security-model.md) |
| 修改内核或提交代码 | [开发指南](development.md) | [实现映射](implementation.md) |
| 查某条规则到底怎么生效 | [配置手册](configuration.md) | [状态与转换](state-machines.md) |
| 一个中台接多个 GitHub 仓库 | [多仓库示例](../examples/recipes/github-multi-repo/README.md) | [配置手册](configuration.md) |

## 权威来源

文档之间不复制全部细节，避免同一件事出现两个版本。发生冲突时，按下面的权威顺序核对：

| 内容 | 权威文档 / 代码 |
| --- | --- |
| HTTP 请求、事件、回执、卡片字段 | [protocol.md](protocol.md) 与 `protocol/schema.json` |
| 配置字段、默认值、校验规则 | [configuration.md](configuration.md) 与 `protocol/rules.ts` |
| 事件、事项、轮次、卡片、交付的状态转换 | [state-machines.md](state-machines.md) |
| 插件入口、生命周期和兼容约定 | [plugins.md](plugins.md) |
| 融合设计与取舍 | [design.md](design.md) |
| 模块、文件与概念的对应关系 | [implementation.md](implementation.md) |
| 安装步骤 | [INSTALL.md](../INSTALL.md) |
| 安全边界与已知限制 | [security-model.md](security-model.md) 与 [SECURITY.md](../SECURITY.md) |
| 面向 Agent 的操作手册 | [skills/agent-autoloop/SKILL.md](../skills/agent-autoloop/SKILL.md) |

`README.md` 负责快速上手和场景入口；本目录负责深入说明。`skills/agent-autoloop/SKILL.md` 是安装后给 Agent 使用的操作手册，包含大量命令示例和交付流水线细节，适合在真实操作时查阅。

## 文档地图

- [architecture.md](architecture.md)：组件边界、单机与分布式部署、事件流、投影、四向插件、失败恢复。
- [design.md](design.md)：设计原则、事件溯源、Policy / Mandate / Decision / Eval、事项阶段、扇出、预演、线程召回、多项目。
- [implementation.md](implementation.md)：设计概念如何落到表、函数、轮次类型和 CLI 上，以及明确未实现的部分。
- [usage.md](usage.md)：安装后初始化、`try`、日常查看、回答、暂停恢复、补跑、诊断、MCP。
- [configuration.md](configuration.md)：`config.json`、`rules.json`、`secrets.env`、环境变量、字段默认值与完整示例。
- [api.md](api.md)：HTTP 端点矩阵、鉴权、常用请求和响应字段速查。
- [plugins.md](plugins.md)：来源 / Agent / 通道三类可加载插件的契约，以及交付方向如何复用 Agent 插件；含模板、安装、测试和兼容规则。
- [operations.md](operations.md)：后台服务、日志、备份恢复、升级卸载、多机部署、故障排查。
- [development.md](development.md)：目录结构、内核边界、测试体系、仿真与穷举、CI、发布。
- [security-model.md](security-model.md)：信任边界、密钥、事件资料隔离、卡片链接、权限限制和已知风险。
- [多仓库 GitHub 示例](../examples/recipes/github-multi-repo/README.md)：按仓库拆分来源和规则，包含路由器、模拟事件和测试。
- [state-machines.md](state-machines.md)：状态转换的权威表格。

## 约定

- 文中“必须”“不能”描述的是当前实现会拒绝或无法保证的行为；“建议”是操作经验，不是内核约束。
- “可选”字段不写时采用默认值；默认值以 [configuration.md](configuration.md) 为准。
- “只读”若指研判或预演轮次，表示内核下发 `access: "read"` 并要求提示词不做事；对 `command` 类 Agent，它不是操作系统级沙箱。详见[安全模型](security-model.md#只读轮次的真实边界)。
- 示例中的 `~/...`、`owner/repo`、密钥和地址都是占位值，替换成自己的。
