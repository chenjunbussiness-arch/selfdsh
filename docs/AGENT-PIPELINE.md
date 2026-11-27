# 多家 agent 串起来干活：流水线设计（草案，待确认）

日期：2026-11-27。状态：设计稿，还没写代码。依赖已经合进 main 的统一阶段、时间线、问答、审计、指标和超时（协议第 12 节），以及本机 MCP 桥（插件 README 第 8.1 节）。

## 0. 目标和分工

把各家 agent 按长处串成一条线，DSH 负责调度和收尾：

| 段 | 谁做 | 交出什么 |
|---|---|---|
| 调度 | 云端 DSH（有界面、能上云）。小活它自己做 | 任务和流水线 |
| 方案 | Claude Code（planner） | `plan.md`（怎么改）和 `acceptance.md`（验收标准） |
| 干活 | Gemini / Antigravity（coder） | 改好的代码、`changes.patch`、`summary.md` |
| 门禁测试 | 谁在线谁跑：本机 dsh worker 或 Gemini | `test.log`、通过 / 不通过 |
| 提交 | 本机 dsh worker | 分支名或提交号 |
| 验收 | Claude Code（reviewer），不能是写这段代码的人 | `review.md`：通过，或带意见退回 |
| 通知 | hub → 发布任务的那台 DSH | 作战室一条：方案、改动、测试、验收结论 |

- Codex 偶尔用，和别家一样接入，不进默认流水线。
- Quick 是临时的，到期不续。设计里不依赖它，到期前照常当 coder 用，到期后 `agent_revoke` 即可。
- 以后加 opencode 等，只写配置和注册，不改 hub 和 router 的代码。

## 1. 从"固定角色"改成"按能力授权"

现在的角色是固定几种（`coder` 不能跑测试、`worker` 什么都能做）。Gemini 既要写代码又要能跑测试，但不该碰 git，固定角色表达不了。

改法：每个 agent 注册时声明自己**能做的事** `can`，批准时只能收窄：

```json
{ "agentId": "agy-mydesk", "platform": "antigravity", "can": ["code", "test"], "capabilities": ["code"] }
{ "agentId": "cc-mydesk",  "platform": "claude-code", "can": ["plan", "review", "code"] }
{ "agentId": "dsh-mydesk", "platform": "dsh",         "can": ["test", "git", "cmd", "code"] }
```

- 可选值：`plan`、`code`、`test`、`git`、`cmd`、`review`。任务的 `needs` 必须全部落在领活人的 `can` 里，否则领不到；派单时直接说为什么不行（沿用 `role-not-coding` 那套提示）。
- 老的 `role` 保留，当成预设：`coder` = `[code]`，`tester` = `[test]`，`worker` = 全部（`review` 除外），`dispatcher` / `observer` 不领活。没写 `can` 的 agent 行为不变。
- 桥在 `next_task` 里把规矩按 `can` 写给 agent（现在按 `role` 写）。

## 2. 流水线模板

在 `hub.json` 里定义几条模板，派活时选一条（`pipeline: "feature"`），不选就是现在的单个任务：

```json
"pipelines": {
  "feature": [
    { "stage": "plan",   "needs": ["plan"],   "prefer": ["cc-mydesk"] },
    { "stage": "code",   "needs": ["code"],   "prefer": ["agy-mydesk", "codex-mydesk"] },
    { "stage": "test",   "needs": ["test"],   "prefer": ["online"] },
    { "stage": "commit", "needs": ["git"],    "prefer": ["dsh-mydesk"] },
    { "stage": "review", "needs": ["review"], "prefer": ["cc-mydesk"], "bounceTo": "code", "maxBounces": 2 }
  ],
  "small": [ "code", "test", "commit", "review" ],
  "tiny": [ { "stage": "self", "needs": ["code", "test"], "prefer": ["dsh-self"] } ]
}
```

- **怎么跑**：hub 建一个父任务，每段是一个子任务，用现有的 `depends_on` 串起来。父任务的阶段就是当前在哪一段，时间线里每条事件多一个 `stage`，调度台把父任务画成一条段落条（方案 ✓ → 干活 ✱ → 测试 ○ …），每段谁做的、花了多久都看得到。
- **谁来做**：`prefer` 是先后顺序，`online` 表示能做的人里谁在线给谁。门禁测试默认 `online`：本机 dsh worker 和 Gemini 谁先领到谁跑。测试命令用工作区自己的 `verify`（router-b partition 里已经有这个字段），不让 agent 临场决定跑什么。
- **小活**：`tiny` 由 DSH 自己做（就是现在的 `dsh-self` 兜底那条路），不经过别家。用哪条模板由 DSH 派活时判断，你也可以在作战室里直接说。

## 3. 段和段之间传什么

每段的产出挂在自己的子任务上，下一段领活时自动当输入（`depends_on` 现有机制）：

| 段 | 必须交 | 下一段拿来做什么 |
|---|---|---|
| plan | `plan.md`、`acceptance.md` | coder 照方案改；reviewer 照验收标准审 |
| code | `changes.patch`、`summary.md` | 测试和提交用补丁；reviewer 看改了什么 |
| test | `test.log`，结论写在 `summary` 首行（通过 / 不通过 + 失败条数） | 不通过就不进 commit，直接退回 code |
| commit | 分支名 / 提交号 | reviewer 看的是提交后的状态 |
| review | `review.md`，首行 `通过` 或 `退回`，后面是逐条意见 | 退回时作为 code 段的输入 |

缺了必须交的文件，hub 不收这个结果（返回明确的错误，agent 补交）。桥已经会给 coder 自动附 `changes.patch`。

## 4. 退回和上限

- 测试不通过、或验收写了 `退回`：hub 新建一轮 code → test → commit → review，code 段的输入多两样：上一轮的 `review.md` / `test.log`、上一轮的补丁。
- 每条流水线最多退回 `maxBounces` 次（默认 2）。用完还不过，父任务进 `waiting_input`，作战室问你：再给一轮、换人做、还是到此为止。这用的是现有的问答闭环。
- 一轮里某段没人接，照现有兜底规则退回发布它的 DSH 决定。

## 5. 验收不能自己审自己

- hub 记下这条流水线里每个 code 段的执行人。review 段的候选人里排除他们（按 agent id）。
- 同一个 Claude Code 可以既出方案又验收，只要那段代码不是它写的。如果 Gemini 不在、Claude Code 顶上写了代码，这一轮的验收就必须换人（另一个 reviewer 或 DSH），没人就问你。
- 审计里能看到每段的执行人，事后能查。

## 6. 额度

各家的额度分开算，用完了不再派给它：

```json
"quota": {
  "agy-mydesk": { "tasksPerDay": 60, "minutesPerDay": 480 },
  "cc-mydesk":  { "tasksPerDay": 20, "costPerDay": 10 }
}
```

- 计数来自现有指标（按执行人的任务数、运行时长）。花费需要 agent 自己报：`submit_result` 加一个可选的 `usage`（tokens、cost），无界面运行器能从 CLI 的 JSON 输出里读到（`agy -p --output-format json` 带 `usage`）。
- 到 80% 在作战室提醒一次；用完后这个 agent 不再领新活，它所在的段按 `prefer` 换下一个；都不行就退给 DSH 决定，并告诉你是额度用完。
- 调度台指标表加一列"今日用量 / 额度"。

## 7. 接入方式：加一个新 agent 只写配置

三种接法，按 agent 的能力选：

| 接法 | 适合 | 现状 |
|---|---|---|
| 本机 MCP 桥 `mcp_bridge.py` | 有 MCP 的 agent，人在 IDE 里叫它干活：Antigravity、Claude Code、Codex、opencode | 已做，见插件 README 第 8.1 节 |
| 无界面运行器（新） | 同一批 agent 的命令行版，要无人值守 | 待做 |
| 常驻客户端 `agent_client.py run` | 本机 DSH worker | 已有 |

**无界面运行器**：一个小脚本，按 `agents/<id>.json` 里的配置定时运行：

```json
"runner": { "every": 120, "command": ["agy", "-p", "{prompt}", "--output-format", "json"], "cwd": "{workspace_path}" }
```

- 先问 hub 有没有它能领的活（新加一个只读接口 `GET /v1/peek`，不领活、不花模型额度）；有才启动 CLI，提示词固定为"调用 dsh-hub 的 next_task 领活，按 task.local.rules 做，做完 submit_result"，MCP 配置指向同一个桥。
- 向 hub 声明 `pull_every_seconds`，作战室就会显示"按计划来领"，不再提示"没人接"。
- 换一家只改 `command`。已核实：Antigravity CLI 的 `agy -p`（输出到 stdout，`--output-format json` 带 `usage`，用交互登录后缓存的凭据，headless 下要在权限设置里放行 `mcp(dsh-hub/*)`）。Claude Code 的 `claude -p` 在开发机上实测可用。Codex、opencode 的无界面命令还没核实，接入时再查。

**接入合同**（每家都一样）：注册一个自己的身份并声明 `can`；只用那五个工具；做完交本段必须交的文件；做不了就 `release_task`；拿不准就 `submit_result` 的 `partial` + `needs_input` 问人。

## 8. 完成后通知

- 验收通过：父任务 `completed`，hub 给发布它的那台 DSH 发一条（现有信箱，只投给发布方），作战室显示：做了什么、改了哪些文件、测试结果、验收结论、分支名。
- 退回用完、额度用完、没人接：都是"需要你决定"那一类，作战室里能直接回答。

## 9. 分期

1. **能力授权 + 流水线模板 + 退回上限 + 验收排除作者**（hub 和插件）。做完就能手动派一条 `feature` 流水线跑通。
2. **额度和用量**：`usage` 字段、额度检查和换人、指标表加列。
3. **无界面运行器和 `/v1/peek`**：Gemini、Claude Code 无人值守。
4. **调度台段落条**：父任务按段显示，每段可以点开看产出。

每期都在真 DSH 上测完再开 PR。

## 10. 需要你确认

1. git 提交和推送只给本机 dsh worker，Gemini 只能 `code` + `test`，行吗？
2. 退回上限默认 2 次，用完问你，行吗？
3. 额度按什么算：每天任务数和时长（现在就能统计），还是按 token 花费（要各家报用量）？
4. 第 1 期做完后，`agy-mydesk` 要从现在的 `coder` 放宽成 `code` + `test`，需要你在 DSH 里重新批准一次。
