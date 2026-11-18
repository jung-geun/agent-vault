# Agent Vault

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

[![skills.sh](https://skills.sh/b/jung-geun/agent-vault)](https://skills.sh/jung-geun/agent-vault)

**一个记忆工具层，让用户、项目和工作知识在更换智能体与开发环境后仍能延续使用。**

Agent Vault 不只是保存对话，而是记录知识的含义、关系、条件和推导依据，并随着新证据的出现逐步改进。为避免绑定某个特定工具，它提供技能（Skill）、MCP 服务器和 CLI，可以接入 Claude Code、Codex、Cursor、OMP 等支持技能和 MCP 的环境。OMP 只是受支持的环境之一，并非必需。

## 安装

推荐使用 Node.js 24 LTS。运行下面的命令时，请选择要使用的智能体。

```sh
npx skills add jung-geun/agent-vault -g
```

`-g` 表示为当前用户全局安装。安装来源是 GitHub 仓库名 `jung-geun/agent-vault`，而不是 npm 包名。

安装之后，请使用智能体的技能调用功能，或在聊天中提出请求：**“用 agent-vault 技能设置这个项目”**。之后无论是设置还是使用记忆，都不需要在终端里反复运行 `npx`。

## 主要功能

- **保持上下文：** 保存用户偏好、项目决策和工作状态，并在后续任务中调用。
- **记忆分离：** 区分全局、项目和角色范围，并区分短期工作状态与长期知识。
- **基于证据的改进：** 将用户的更正视为重新评估的信号，并将现有知识与新证据进行比较。证据不足时会暂缓更新。
- **在任务边界整理：** 使用次数和时间老化只会安排一次审查。已审查的变更会在任务正常结束或空闲时应用，不会打断正在进行的任务。
- **本地存储：** 文档和短期记忆保存为 Markdown，长期记忆和审查记录保存在 SQLite 中。也可以用 Obsidian 查看 Markdown 文档。
- **每周记录：** 将知识、日志和交接按日期和星期汇总到单个 `YYYY-WW.md` 中。进行中的任务即使过了周一，也仍留在其开始的工作周内，在 SQLite 中可按日期或关键词查询。
- **用户 persona：** 连同依据一起管理提问、编码、工作指示和工作时间的模式，用来调整回答和提问方式。当前请求始终优先，观察结果不会被当作事实或权限。
- **可选的团队共享：** 只使用明确配置的团队存储，不会自动共享个人记忆。
- **排序式回忆与健康检查：** `agent-vault recall` 不使用网络，在本地按关键词对与任务描述相符的记忆排序。可选的自动回忆只会把结果作为背景信息附加到 Claude Code 和 Codex 的提示中，不会被当作指令。`agent-vault status` 会报告数量、审查队列以及每个问题的具体处理方法。
- **正则、相似度与本地嵌入检索：** 检索支持 `regex` 和 `similar` 模式，返回前 5 条（最多 10 条）结果。`similar` 在本机有小型嵌入模型（Ollama 或 LM Studio，仅限回环地址）时使用它，否则使用字符相似度，因此没有模型也能使用。只有用 `similar` 检索时才会做嵌入。对中文、韩文等非英文笔记，请使用多语言模型（例如 `granite-embedding:278m`），而不是仅支持英文的模型。

## 使用方法

下面是**发送给智能体的请求**。它们不是终端命令，`/agent-vault` 之类的调用语法只有在所用环境支持时才能使用。

| 请求示例 | 作用 |
| --- | --- |
| `agent-vault setup` | 设置当前项目和存储库，并为所用环境完成本地 MCP 连接。 |
| `agent-vault install` | 注册或修复已安装技能的 MCP 连接。 |
| `agent-vault status` | 检查技能、MCP、项目和任务 hooks 的连接状态。 |
| `agent-vault recall 上周的部署决定` | 按日期或关键词查找记录，并附带依据回答。 |
| `agent-vault remember 这次的决定和原因` | 区分为工作状态或长期知识进行记录。 |
| `agent-vault review 结果和之前的记录不一样` | 比较已有依据与新证据并重新评估。 |
| `agent-vault persona 显示我的回答偏好` | 显示正在生效的偏好和待审查的观察。 |
| `agent-vault config 每周 Markdown 保留 3 个月，工作从 09:00 开始` | 应用所请求的保留期限和工作时间设置。 |

### MCP 是内部运行机制

**技能负责指导智能体如何执行命令，存储、检索和审查由本地 MCP 服务器完成。** 智能体使用已安装包中的 CLI 完成初始设置，工具层则用 Node 运行同一个包中的 MCP 服务器。不需要用户每次手动运行，也不会重新下载软件包。

如果首次连接需要权限确认或重启智能体，会提示一次。对于无法自动注册 MCP 或 hooks 的环境，会说明所需步骤和限制，不会把尚未连接的状态当作已完成。

### 记忆在任务边界更新

工作周按周一到周日计算，进行中的任务即使跨周也保持其原来的工作周。Markdown 只保留设定的 **1～6 个月**，SQLite 记录仍可持续查询。

persona 和已审查的记忆变更会在任务正常结束后的空闲时刻生效。在没有 hooks 的环境中，可以在工作结束后请求 `agent-vault maintain`。已有的按日文件通过 `agent-vault migrate` 导入，删除原文件需要另行明确请求。

### hooks 何时运行以及各工具的作用

在 OMP、Claude Code 和 Codex 中，hooks 会在你发送提示时启动任务，记录你的指示和每个修改文件的回合，并在智能体结束时关闭任务。请智能体执行 `agent-vault install` 即可完成设置：对 Claude Code 和 Codex 会运行 `vault-cli hooks install --host claude|codex`，之后 Codex 会要求你在 `/hooks` 中审查并信任这些 hooks 一次。维护和 persona 更新只会在任务正常完成且没有其他任务进行时运行。Cursor 等其他环境不会安装 hooks，需要改为请求 `agent-vault maintain`。确切的事件与时机、全部 MCP 工具、实际验证过的范围以及失败时的行为，请参阅 **[spec.md](spec.md)**。

详细的工具约定请参阅 [SKILL.md](SKILL.md)。官方的 [Skills 自定义](https://www.skills.sh/docs/customize)作用于仓库的介绍页面，不会为正在运行的智能体注册命令或 hooks。
