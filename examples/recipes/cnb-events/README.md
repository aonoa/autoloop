# 跟进 CNB 仓库事件

## 解决什么

把 CNB 的 Issue、评论、Pull Request 和 push 变成中台事件，规则可以像 GitHub 一样按仓库和编号匹配：`issues.opened`、`issue_comment.created`、`pull_request.closed`、`push`。

CNB 没有仓库级的外发 Webhook。这里有两种入口，按仓库情况选一种：

- **轮询仓库动态**：不需要仓库有流水线，也不需要公网。中台定时跑 `plugins/cnb/poll.ts`，读 CNB OpenAPI 的仓库动态，把新事件交回中台。代价是最多晚一个轮询周期，并且要一枚能读 Issue 的访问令牌。
- **流水线转发**：仓库已经有 `.cnb.yml` 时，在关心的事件流水线里执行 `plugins/cnb/push.ts`，把构建自己的 `CNB_*` 变量签名后转给中台。它比轮询及时，但只覆盖配置了流水线的事件。

两种入口都只是“翻译”。派不派活、交给谁、在哪个目录、什么权限，仍只由中台的规则决定。

## 怎么启用

### 轮询

1. 把 `rules.json` 的 `sources`、`agents`、`rules` 合并进 `~/.agent-autoloop/rules.json`，保留已有条目。
2. 把两处 `worker` 换成接单电脑，把 `cwd` 换成代码目录，把 `owner/app` 换成仓库全路径。
3. 在接单电脑上给 `cnb-watch` 一个能读仓库动态和 Issue 的令牌。令牌放环境变量，不进 `rules.json`：

   ```bash
   CNB_TOKEN=<访问令牌> CNB_HOURS=2 node /绝对路径/agent-autoloop/plugins/cnb/poll.ts owner/app
   ```

   接单程序启动 Agent 时会保留普通环境变量；如果服务没有继承它，用一个只导出该变量的包装脚本，把 `command` 指向包装脚本。

4. 运行 `agent-autoloop check`，再手动跑一次上面的命令，确认它输出“没事可做”或回执里的事件。

令牌至少要有仓库动态和 Issue 的读取权限（平台把后者写作 `repo-issue:r`）。CNB 的按小时动态接口对没有动态的小时返回 404，这是正常的，不是令牌失效。读 Issue 时请求要带 `Accept: application/json`，否则平台返回 406。

### 流水线转发

1. 在 `secrets.env` 写与流水线一致的签名密钥，重启中台：

   ```dotenv
   AGENT_AUTOLOOP_SECRET_CNB=一段足够长的随机字符串
   ```

2. 把 `plugins/cnb/push.ts` 和 `core.ts` 放进被监听仓库的 `.cnb/autoloop/`。流水线里只传字段，不把密钥写进命令；签名密钥放进密钥仓库文件，用 `imports` 导入：

   ```yaml
   env:
     AUTOLOOP_URL: https://你的中台地址
   imports:
     - https://cnb.cool/你的/密钥仓库/-/blob/main/autoloop.yml # AUTOLOOP_CNB_SECRET: …
   $:
     issue.open:
       - stages:
           - script: node .cnb/autoloop/push.ts
   ```

   评论、PR 和 push 各自挂在对应的事件下；`CNB_REPO_SLUG`、`CNB_EVENT`、`CNB_EVENT_URL`、`CNB_ISSUE_*`、`CNB_PULL_REQUEST_*`、`CNB_COMMENT_BODY`、`CNB_COMMENT_TYPE` 都由平台提供。

3. 中台要在流水线能访问到的地址上。字段转换在 `plugins/cnb/source.ts`，地址是 `/v1/in/cnb`。

转发脚本只发当前构建的事件。同一条流水线重复执行时事件 id 相同，中台只记一次；换了提交或流水线编号才会产生新事件。

## 工作流程

`plugins/cnb/core.ts` 把两边的字段合成同一个形状：

| CNB 来源                                   | 中台事件                              | `subject`         |
| ------------------------------------------ | ------------------------------------- | ----------------- |
| `IssueEvent` + `opened`                    | `issues.opened`                       | `owner/repo#编号` |
| `IssueCommentEvent` + `opened`             | `issue_comment.created`               | `owner/repo#编号` |
| `PullRequestEvent` + `opened`              | `pull_request.opened`                 | `owner/repo#编号` |
| `PullRequestEvent` + `merged`              | `pull_request.closed`                 | `owner/repo#编号` |
| `PullRequestReviewCommentEvent` + `opened` | `pull_request_review_comment.created` | `owner/repo#编号` |
| `PushEvent`                                | `push`                                | `owner/repo`      |

其余动作按 CNB 自己的动作名生成，例如 `issues.labeled`、`pull_request_review.created`。CNB 动态里的评论动作写作 `opened`，这里换成 GitHub 的 `created`，规则不必为两家平台写两套。push 不带编号，否则同一个分支每次推送都会被当成不同的对象，历史会散开。

事件 id 取平台的原值。平台的 id 是 64 位整数，Node 的 `JSON.parse` 会四舍五入，所以实现先从原始文本里取出 id，再解析其余字段；否则相差 1 的两条事件会被当成同一条。

## 要改哪几处

- 轮询的 `owner/app`、`worker`、`cwd` 和 Agent 的 `use`。
- 令牌不要写进 `rules.json`、示例或仓库；轮询读 `CNB_TOKEN`，转发读 `AUTOLOOP_CNB_SECRET`。
- 权限：`read`。只读代码；要改本地文件才换成 `edit`，仍然不提交、不推送，除非你明确要求。
- 轮询间隔默认 10 分钟，`CNB_HOURS` 默认回看 2 小时；两个值要覆盖平台数据延迟，重复读到的旧事件由中台去重。

## 本地验证

```bash
node --disable-warning=ExperimentalWarning --test tests/cnb.test.ts
```

测试用固定的 CNB 返回结构检查字段映射、64 位 id、逐行流、Issue 正文补全和单个仓库失败不影响其他仓库；不连接真实 CNB，也不发真实通知。
