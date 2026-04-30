# 软件开发公司 AI 工作流

这是一个面向软件开发公司的 AI 工作流 MVP。它可以把客户的原始需求、会议纪要或项目设想，整理成一套结构化交付包：

- 需求发现简报
- PRD 与需求 Backlog
- 技术架构方案
- 迭代计划与 Issue 草案
- QA、安全与代码评审计划
- 客户交付与运维清单

当前版本使用确定性工作流引擎，因此不需要 API Key 也能运行。接口和页面结构已经按 Agent 工作流设计，后续可以逐步替换为真实 LLM Agent，并接入 GitHub、Jira、企业微信、MCP 工具或内部项目管理系统。

如果配置了 `OPENAI_API_KEY`，系统会优先使用真实 LLM Agent 生成 6 阶段交付包和结构化 Backlog；如果模型调用失败，会自动回退到规则引擎。

## 架构

```text
浏览器工作台
  -> Node.js 或 FastAPI 服务
      -> WorkflowEngine
          -> 需求接收与业务澄清
          -> PRD 与需求 Backlog
          -> 技术方案与系统架构
          -> 研发实施计划
          -> 测试、安全与代码评审
          -> 客户交付与运维闭环
```

## 推荐启动方式

当前机器如果没有真实 Python 环境，可以直接用 Node.js 版本：

```bash
cd advanced_ai_agents/multi_agent_apps/software_dev_ai_workflow
npm start
```

打开：

```text
http://127.0.0.1:8901
```

## 环境变量配置

Node.js 版本会在启动时自动读取当前目录下的 `.env` 文件。可以复制模板后按需填写：

```bash
cp .env.example .env
```

PowerShell 也可以使用：

```powershell
Copy-Item .env.example .env
```

`.env` 已经被仓库根目录的 `.gitignore` 忽略，适合保存本地 API Key、GitHub Token 和 Jira Token。

如果本机安装了 CC Switch，也可以让项目直接读取 CC Switch 当前 Codex provider：

```env
AI_CONFIG_SOURCE=cc-switch
```

启用后，项目会从 `~/.cc-switch/settings.json` 和 `~/.cc-switch/cc-switch.db` 读取当前 Codex provider 的 `OPENAI_API_KEY`、`base_url` 和 `model`。`.env` 中的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 可以留空。

## 启用真实多 Agent 团队

PowerShell 示例：

```powershell
$env:OPENAI_API_KEY="你的 OpenAI API Key"
$env:OPENAI_BASE_URL="https://api.openai.com"
$env:OPENAI_MODEL="gpt-4o-mini"
$env:OPENAI_MAX_RETRIES="3"
$env:OPENAI_REQUEST_TIMEOUT_MS="600000"
npm start
```

未配置 `OPENAI_API_KEY` 时，应用仍会使用本地规则引擎生成结果。

`OPENAI_BASE_URL` 可选，默认是官方接口 `https://api.openai.com`。如果使用兼容网关，可以改成网关地址，例如 `https://api.pptoken.org`，服务会自动请求 `/v1/responses`。

`OPENAI_MAX_RETRIES` 可选，默认重试 3 次，用于缓解 429、503 等临时性上游错误。

`OPENAI_REQUEST_TIMEOUT_MS` 可选，当前模板为 600000 毫秒，即单个 Agent 最长等待 10 分钟。单个 Agent 超时后会保留规则引擎结果，避免页面长时间卡住。

配置 `OPENAI_API_KEY` 后，Node.js 版本会先立即返回规则引擎交付包，然后在后台按 6 个角色逐段优化。每次只执行一个 Agent，前端会显示当前 Agent 和已完成 Agent：

- 需求分析 Agent
- 产品经理 Agent
- 架构师 Agent
- 研发负责人 Agent
- QA 与 Review Agent
- 交付经理 Agent

其中研发负责人 Agent 会单独生成结构化 `backlog_issues`，用于创建 GitHub/Jira Issues。

## 接入 GitHub Issues

配置：

```powershell
$env:GITHUB_TOKEN="你的 GitHub Personal Access Token"
$env:GITHUB_REPO="owner/repo"
npm start
```

运行工作流后，点击页面右上角的“创建 GitHub Issues”，系统会把结构化 Backlog 创建到目标仓库。

## 接入 Jira Issues

配置：

```powershell
$env:JIRA_BASE_URL="https://your-domain.atlassian.net"
$env:JIRA_EMAIL="你的 Atlassian 登录邮箱"
$env:JIRA_API_TOKEN="你的 Jira API Token"
$env:JIRA_PROJECT_KEY="PROJ"
$env:JIRA_ISSUE_TYPE="Task"
npm start
```

运行工作流后，点击页面右上角的“创建 Jira Issues”，系统会把结构化 Backlog 创建到 Jira 项目。

## FastAPI 启动方式

如果已经安装 Python：

```bash
cd advanced_ai_agents/multi_agent_apps/software_dev_ai_workflow
pip install -r requirements.txt
python app.py
```

## API

运行工作流：

```bash
curl -X POST http://127.0.0.1:8901/api/workflows/run \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "AI 合同审查门户",
    "client_name": "某法律服务公司",
    "industry": "法律科技",
    "goal": "建设一个安全的 Web 应用，用于合同上传、知识库问答、风险条款识别、审查报告生成和人工审批。",
    "source_material": "需要登录、角色权限、RAG 检索、数据看板、文件上传、PDF 导出和审计日志。",
    "constraints": "需要隐私保护和人工审批。",
    "target_users": "律师、律师助理、管理员",
    "tech_stack": "Next.js、FastAPI、Postgres、Redis、Qdrant"
  }'
```

导出最近一次工作流：

```text
GET /api/workflows/latest/export
```

创建 GitHub issues：

```text
POST /api/integrations/github/issues
```

创建 Jira issues：

```text
POST /api/integrations/jira/issues
```

## 后续产品化方向

- 增加工作流运行记录持久化。
- 增加登录、组织、角色和权限体系。
- 增加 GitHub/Jira 双向同步，回写 issue 状态和负责人。
- 增加 PR Review Agent，读取 diff 并生成审查意见。
- 增加 Trace、模型调用成本、人工审批和审计日志。
- 增加法律、制造、金融、教育、客服等垂直行业模板。
