# 运维手册

本文说明部署、后台服务、日志、备份恢复、升级卸载和故障排查。安装步骤见 [INSTALL.md](../INSTALL.md)，安全边界见 [security-model.md](security-model.md)。

## 运行形态

`agent-autoloop up` 在一个进程里启动配置中的部分：

- 有 `hub`：启动 HTTP 中台；
- 有 `worker`：启动接单程序；
- 有 `channels`：逐个启动通道；
- 三者通过 HTTP 协议通信，单机也不例外。

中台和 worker 可以分开部署。工作机不需要开放入站端口。

## 后台服务

### macOS

安装 launchd 用户级服务：

```bash
agent-autoloop service install
```

文件：`~/Library/LaunchAgents/agent-autoloop.plist`。

日志：`~/.agent-autoloop/logs/up.log`。

### Linux

安装 systemd 用户级服务：

```bash
agent-autoloop service install
```

```bash
systemctl --user status agent-autoloop
journalctl --user -u agent-autoloop -n 100
```

非默认 `AGENT_AUTOLOOP_HOME` 会生成带哈希后缀的服务名，避免覆盖默认安装。

### Windows

安装当前用户的登录任务：

```powershell
agent-autoloop service install
```

日志：`%USERPROFILE%\.agent-autoloop\logs\up.log`。

Windows 自带的 Administrator 账号不能同时满足“不提权”和“不以管理员权限运行 Agent”，安装器会拒绝创建任务并打印改用「启动」文件夹的命令。

### 移除服务

```bash
agent-autoloop service remove
```

只移除服务，不删除规则、密钥和记录。

## 端口与网络

默认：

```json
"hub": { "listen": "127.0.0.1:3350", "publicUrl": "http://127.0.0.1:3350" }
```

- `listen` 必须是 `主机:端口`；IPv6 用 `[地址]:端口`；
- 监听 `0.0.0.0` 或局域网地址会对外开放，日志会提醒；
- 公网部署必须在前面放 HTTPS 反向代理；
- 只暴露反向代理的 443，不直接暴露 SQLite 或文件目录；
- `publicUrl` 用于卡片链接，手机访问时必须写外部可达地址。

Windows 端口被 Hyper-V/WSL 保留时：

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

换一个范围外端口，同时修改 `url`、`hub.listen` 和必要的 `publicUrl`。

## 日志

| 平台 | 位置 |
| --- | --- |
| macOS | `~/.agent-autoloop/logs/up.log` |
| Windows | `%USERPROFILE%\.agent-autoloop\logs\up.log` |
| Linux | `journalctl --user -u agent-autoloop` |

日志包含：

- 中台监听和错误；
- worker 连接和任务错误；
- 通道重启；
- 插件异常；
- 规则文件错误。

Agent 的 stdout/stderr 和本地执行记录在：

```text
~/.agent-autoloop/worker/runs/<轮次>-<尝试>/
```

这些记录包含业务输出，应按敏感数据管理。轮次输出默认保留 14 天，之后清理。

## 备份

```bash
agent-autoloop backup ~/backups/autoloop-2026-11-13
```

可在中台运行时执行。备份包含：

- `hub.db`：事实日志和投影；
- `master.key`：派生轮次 token 和卡片链接；
- `config.json`：本机身份和密钥；
- `rules.json`：规则；
- `secrets.env`：Webhook 验签秘密（如果存在）。

备份目录权限为 0700，文件 0600（Windows 使用仅本人和 SYSTEM 的 ACL）。备份等同于密钥，不能公开。

手工备份时至少保留 `hub.db` 和 `master.key`，两者必须配套；只恢复其中一个会导致 token 和链接失效。

## 恢复

先停中台：

```bash
agent-autoloop service remove
```

再恢复：

```bash
agent-autoloop restore ~/backups/autoloop-2026-11-13
```

恢复会：

- 校验备份；
- 替换数据库、主密钥、配置、规则和秘密；
- 保留一份安全副本用于失败回滚；
- 要求中台未运行。

恢复后重新安装服务：

```bash
agent-autoloop service install
```

## 升级

```bash
agent-autoloop update
```

- 公开仓库安装跟随最新 Release；
- 本地仓库安装跟随该仓库；
- 更新后重启服务；
- 已领取的轮次继续用旧代码执行到结束；
- 新轮次使用新代码；
- 不需要数据迁移，投影会按需重建。

升级前建议备份。版本号规则见 [protocol.md](protocol.md#版本与兼容)。

## 卸载

```bash
agent-autoloop uninstall
agent-autoloop uninstall --yes
```

卸载会：

- 停止并移除服务；
- 删除程序目录和命令链接；
- 删除 Agent Skill 链接；
- **保留**规则、密钥、数据库和日志。

要彻底清除，先备份，再手动删除 `~/.agent-autoloop`。

## 多机部署

### 中台机

```json
{
  "url": "https://agent.example.com",
  "hub": { "listen": "127.0.0.1:3350", "publicUrl": "https://agent.example.com" },
  "channels": { "feishu": { "key": "…" } },
  "owner": "…"
}
```

- 去掉 `worker`，或保留但不配置 Agent；
- 在反向代理后监听回环地址；
- 只开放 443；
- 备份 `hub.db` 和 `master.key`。

### 工作机

```bash
agent-autoloop join https://agent.example.com --worker mac-mini --key <worker-key>
```

生成：

```json
{
  "url": "https://agent.example.com",
  "worker": { "name": "mac-mini", "key": "…", "capacity": 2 }
}
```

工作机通常没有 `owner`，因此不能看全局状态。规则中 Agent 的 `worker` 必须与这里一致。

### 通道机

通道可以和中台同机，也可以单独运行。单独运行时，`config.json` 需要：

- `url` 指向中台；
- `channels` 中每个通道的密钥和选项；
- 可选 `worker`，但通常不需要。

### 反向代理

必须：

- 终止 TLS；
- 转发 `Authorization` 和 `Last-Event-ID`；
- 对 `/v1/stream` 关闭缓冲；
- 设置合理的读超时，长轮询最长 50 秒；
- 不缓存 `/v1/*`。

## 监控

### 健康检查

```bash
curl -fsS https://agent.example.com/healthz
```

返回 `{ "ok": true, "commit": "…" }`。

### 状态

```bash
agent-autoloop status --json
```

可监控：

- `totals.attention`：待处理卡片数；
- `totals.queued`、`totals.running`、`totals.unknown`；
- `spending.today`、`spending.week`；
- `agents[].online`、`channels[].online`；
- `matters[].stage`；
- `unrouted`。

### 日志流

```bash
curl -N -H "Authorization: Bearer <owner-key>" \
  "https://agent.example.com/v1/stream?after=0"
```

## 故障排查

### 中台起不来

```bash
agent-autoloop doctor
```

检查：

- Node 版本 ≥ 24；
- `config.json` 存在且 JSON 合法；
- `hub.listen` 格式；
- 端口是否被占用；
- 日志中的 `listen EACCES` 或规则错误。

规则写错时启动会失败并指出字段；修正后重启。

### 服务在跑但连不上

- 检查 `url` 和 `listen` 是否一致；
- 检查反向代理是否转发；
- 检查防火墙；
- 检查 `publicUrl` 是否是外部地址；
- 用 `curl /healthz` 直接测试。

### Agent 不接活

- `status` 看 worker 是否在线；
- `rules.json` 中 Agent 的 `worker` 是否与 `config.json` 的 `worker.name` 一致；
- `doctor` 检查 Agent 登录；
- 检查 `worker.capacity`、组 `parallel`、`maxActive`；
- 检查规则是否暂停；
- 检查事件是否被 Policy 拒绝。

### 卡片没送到

- 通道是否在线；
- 规则 `channels` 和 `defaultChannels`；
- `answerers` 是否包含回答人；
- 通道密钥是否有效；
- 平台限流或消息长度限制；
- 卡片链接是否过期。

### 轮次一直 unknown

worker 失联或进程无法核实。检查：

- 工作机是否重启；
- `worker/runs/` 是否还在；
- 日志中的进程组和退出标记；
- 中台与工作机网络；
- 不要手工删除正在执行的记录。

### 数据损坏

- 先停止中台；
- 用 `agent-autoloop backup` 的备份恢复；
- 没有备份时，投影可重建，但事实日志丢失无法恢复业务历史；
- `master.key` 损坏时中台拒绝启动；从备份恢复，或删除后重新生成（已发链接和轮次 token 失效）。

## 容量与性能

实测数据见 [README](../README.md#实测性能) 和 [protocol.md](protocol.md#历史增长实测)。运维要点：

- 单机 SQLite，写入逐条提交；
- 历史增长后状态汇总变慢；
- 格式变化后首次启动需要全量重建投影；
- 长轮询连接占用内存，1000 个并发连接约 170 MB RSS；
- 高频任务应使用 API Key，而不是个人订阅额度；
- 不要把中台当高可用集群；需要高可用时先做外部备份和故障切换方案。

## 发布检查

升级或改配置后：

```bash
agent-autoloop check
agent-autoloop doctor
agent-autoloop try
agent-autoloop status
```

生产环境先在测试中台验证插件：

```bash
agent-autoloop conformance <测试地址> --config <凭据文件>
```
