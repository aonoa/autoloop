# 多个 GitHub 仓库共用一个中台

一个中台可以同时接多个仓库。GitHub Webhook 本身不绑定仓库，事件里带着 `owner/repo#编号`。本示例用**两个来源 id** 在派工前把仓库分开，避免一个仓库的 issue 先被另一个仓库的 Agent 接走。

## 目录

- `rules.json`：两个来源和两个仓库规则的完整配置。
- `route.ts`：按 Webhook 的 `repository.full_name` 把事件送进对应来源；找不到仓库时直接忽略，不派工。
- `event-app.json`、`event-web.json`：可直接发送的模拟事件。

## 为什么不只写两个规则

如果两个规则都监听同一个 `github` 来源，内核只按 `source` 和事件类型匹配。`owner/web` 的 issue 也会先进入 `owner/app` 的规则，Agent 读完资料后才发现不是自己的仓库，浪费一轮 Token，也不是硬隔离。

拆成 `github-app` 和 `github-web` 两个来源后，匹配阶段就知道是哪个仓库：

| 仓库 | Webhook 地址 | 来源 id | 密钥变量 |
| --- | --- | --- | --- |
| `owner/app` | `/v1/in/github-app` | `github-app` | `AGENT_AUTOLOOP_SECRET_GITHUB_APP` |
| `owner/web` | `/v1/in/github-web` | `github-web` | `AGENT_AUTOLOOP_SECRET_GITHUB_WEB` |

每个仓库可以在 GitHub 里单独设置 Webhook 的 Secret。来源 id 里的 `-` 在环境变量里写成 `_`。

## 怎么启用

1. 把 `rules.json` 的 `sources`、`agents`、`rules` 合并进 `~/.agent-autoloop/rules.json`，保留已有条目。
2. 把两处 `worker` 换成接单电脑，把两处 `cwd` 换成各自的代码目录。
3. 在 `secrets.env` 写两个 Webhook Secret：

   ```dotenv
   AGENT_AUTOLOOP_SECRET_GITHUB_APP=app-repository-webhook-secret
   AGENT_AUTOLOOP_SECRET_GITHUB_WEB=web-repository-webhook-secret
   ```

4. 运行 `agent-autoloop check`，再运行 `agent-autoloop service install` 让中台重新加载来源和秘密。

## GitHub Webhook

在 `owner/app` 仓库的 **Settings → Webhooks → Add webhook** 填：

```text
Payload URL: https://你的中台地址/v1/in/github-app
Content type: application/json
Secret: 与 AGENT_AUTOLOOP_SECRET_GITHUB_APP 相同
Events: Issues, Issue comments, Pull requests
```

在 `owner/web` 仓库填同样的内容，但地址改成 `/v1/in/github-web`，Secret 用 `AGENT_AUTOLOOP_SECRET_GITHUB_WEB`。这样不用路由器，两个仓库分别直达各自的来源。

中台默认只监听 `127.0.0.1`。GitHub 要能访问它，必须把 `hub.listen` 改成可达地址，并放在 HTTPS 反向代理后面；不要直接把中台端口暴露到公网。也可以用隧道，见[运维手册](../../../docs/operations.md#反向代理)。

## 工作流程

默认方式是两个仓库分别把 Webhook 送到 `/v1/in/github-app` 和 `/v1/in/github-web`。如果不想暴露两个入口，也可以只开放一个 `/github`：`route.ts` 按 `payload.repository.full_name` 选择目标来源，再把签名后的原始请求转发到对应的 `/v1/in/<来源>`。两种方式都由中台重新验签，路由器本身不能授予派工权限。

使用路由器时，在仓库目录运行：

```bash
ROUTE_LISTEN=127.0.0.1:3351 \
AGENT_AUTOLOOP_URL=http://127.0.0.1:3350 \
node ~/.agent-autoloop/routes/github-multi-repo.ts
```

再把两个仓库的 Payload URL 都填成 `https://你的公网地址/github`。反向代理只需要把 `/github` 转到这个路由器的 `3351`；路由器再访问本机的 `AGENT_AUTOLOOP_URL`，把请求送进中台。`rules.json` 不需要改，因为转发后的请求仍然进入 `github-app` 或 `github-web` 来源。

每个仓库的规则收到事件后：

- `owner/app` 交给 `app-agent`，在 `~/code/app` 工作；
- `owner/web` 交给 `web-agent`，在 `~/code/web` 工作；
- 每个 issue 单独成事项，最多并行 2 个；
- Agent 只在本地修改，不提交、不推送、不回复 issue。

## 本地验证

先确认路由脚本能按仓库分出两个来源，不连接中台：

```bash
node examples/recipes/github-multi-repo/route.ts --self-test
```

然后用两个来源密钥分别发送模拟事件。下面的 `<APP_KEY>`、`<WEB_KEY>` 用 `agent-autoloop key new source github-app` 和 `agent-autoloop key new source github-web` 创建：

```bash
curl --fail-with-body http://127.0.0.1:3350/v1/events \
  -H "Authorization: Bearer $APP_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/recipes/github-multi-repo/event-app.json

curl --fail-with-body http://127.0.0.1:3350/v1/events \
  -H "Authorization: Bearer $WEB_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/recipes/github-multi-repo/event-web.json
```

预期第一个只派给 `app issue`，第二个只派给 `web issue`。再用 `agent-autoloop board` 查看两个独立事项。

## 要改哪几处

- 两个 `worker`、两个 `cwd` 和两处 Agent `use`；
- `owner/app`、`owner/web` 换成真实仓库；
- 使用共享入口时，把 `route.ts` 放到固定目录并配置 `ROUTE_LISTEN`、`AGENT_AUTOLOOP_URL`；
- 如果需要改代码，把 Agent 的 `access` 从 `read` 改成 `edit`，并先确认后台 Agent 有该目录权限；
- 权限：`read`。本示例只读代码和 issue 资料，不改文件、不联网；需要改代码时再显式放宽。

## 已知限制

`subject` 目前只是事件字段，规则的 `when` 没有 `repo` 或 `subject` 条件。本示例用来源 id 做匹配阶段隔离，所以仓库数量少、可以逐仓库配置 Webhook 时最合适。仓库很多时，应给协议增加通用的 `subject` 过滤，而不是在核心里加入 GitHub 专用的 `repo` 字段。

