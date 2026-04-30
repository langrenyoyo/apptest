const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function loadEnvFile(filePath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

function parseCodexConfig(configText) {
  const model = configText.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  const baseUrl = configText.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1];
  return { model, baseUrl };
}

function loadCcSwitchConfig() {
  if ((process.env.AI_CONFIG_SOURCE || "").toLowerCase() !== "cc-switch") return;
  const script = String.raw`
import json, os, sqlite3
root = os.path.join(os.path.expanduser("~"), ".cc-switch")
settings_path = os.path.join(root, "settings.json")
db_path = os.path.join(root, "cc-switch.db")
settings = json.load(open(settings_path, encoding="utf-8"))
provider_id = settings.get("currentProviderCodex")
if not provider_id:
    raise SystemExit("currentProviderCodex is not configured")
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
row = conn.execute("select settings_config from providers where id = ? and app_type = 'codex'", (provider_id,)).fetchone()
endpoint = conn.execute("select url from provider_endpoints where provider_id = ? and app_type = 'codex' order by id desc limit 1", (provider_id,)).fetchone()
conn.close()
if not row:
    raise SystemExit("current Codex provider was not found")
config = json.loads(row["settings_config"] or "{}")
auth = config.get("auth") or {}
print(json.dumps({
    "apiKey": auth.get("OPENAI_API_KEY") or auth.get("API_KEY") or "",
    "config": config.get("config") or "",
    "endpoint": endpoint["url"] if endpoint else ""
}))
`;
  try {
    const raw = execFileSync("python", ["-c", script], { encoding: "utf8", timeout: 5000 });
    const ccConfig = parseJsonLenient(raw);
    const parsed = parseCodexConfig(ccConfig.config || "");
    if (ccConfig.apiKey) process.env.OPENAI_API_KEY = ccConfig.apiKey;
    if (parsed.baseUrl || ccConfig.endpoint) process.env.OPENAI_BASE_URL = parsed.baseUrl || ccConfig.endpoint;
    if (parsed.model) process.env.OPENAI_MODEL = parsed.model;
    process.env.AI_CONFIG_SOURCE_ACTIVE = "cc-switch";
  } catch (error) {
    process.env.AI_CONFIG_SOURCE_ACTIVE = "env";
    process.env.AI_CONFIG_SOURCE_ERROR = error.message;
  }
}

loadCcSwitchConfig();

const PORT = Number(process.env.PORT || 8901);
let lastRun = null;
let workflowStatus = {
  running: false,
  current_agent: "",
  completed_agents: [],
  started_at: null,
  finished_at: null,
  error: "",
  workflow_id: "",
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function titleLabel(key) {
  const labels = {
    estimated_sprints: "预估迭代数",
    epics: "业务模块",
    stories: "用户故事",
    risks: "风险项",
    integrations: "集成项",
  };
  return labels[key] || key;
}

function getOutputText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function stripMarkdownFence(textValue) {
  return String(textValue)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractFirstJsonValue(textValue) {
  const text = stripMarkdownFence(textValue);
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) return text;
  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

function parseJsonLenient(textValue) {
  const cleaned = stripMarkdownFence(textValue);
  try {
    return JSON.parse(cleaned);
  } catch {
    return JSON.parse(extractFirstJsonValue(cleaned));
  }
}

function openAIResponsesUrl() {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
  if (baseUrl.endsWith("/responses")) return baseUrl;
  if (baseUrl.endsWith("/v1")) return `${baseUrl}/responses`;
  return `${baseUrl}/v1/responses`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableOpenAIStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function updateWorkflowStatus(patch) {
  workflowStatus = { ...workflowStatus, ...patch };
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} 超时：超过 ${Math.round(ms / 1000)} 秒未返回`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function buildIssueDrafts(epics) {
  return epics.flatMap((epic, index) => [
    {
      key: `DEV-${index + 1}1`,
      title: `实现「${epic}」后端 API`,
      body: `## 背景\n围绕「${epic}」实现后端能力，支撑软件交付工作流的核心场景。\n\n## 验收标准\n- API 具备输入校验和错误响应。\n- 关键操作写入审计日志。\n- 覆盖权限校验和基础测试。`,
      labels: ["ai-workflow", "backend"],
      issue_type: "Task",
    },
    {
      key: `DEV-${index + 1}2`,
      title: `实现「${epic}」前端工作流`,
      body: `## 背景\n为「${epic}」提供清晰、可操作的前端页面和状态反馈。\n\n## 验收标准\n- 页面覆盖成功、加载、失败和空状态。\n- 表单字段具备基础校验。\n- 与后端 API 联调通过。`,
      labels: ["ai-workflow", "frontend"],
      issue_type: "Task",
    },
    {
      key: `DEV-${index + 1}3`,
      title: `补充「${epic}」审计日志、异常状态和权限校验`,
      body: `## 背景\n保证「${epic}」满足生产环境的可追踪、可恢复和权限隔离要求。\n\n## 验收标准\n- 关键事件写入审计日志。\n- 异常路径可重试或可人工介入。\n- 租户和角色权限测试通过。`,
      labels: ["ai-workflow", "quality"],
      issue_type: "Task",
    },
  ]);
}

function extractSignals(request) {
  const text = [
    request.project_name,
    request.industry,
    request.goal,
    request.source_material,
    request.constraints,
    request.target_users,
    request.tech_stack,
  ].join(" ");
  const lowered = text.toLowerCase();

  const featureHints = [
    ["账号、权限与组织角色", ["login", "auth", "permission", "role", "用户", "权限", "登录", "账号", "角色"]],
    ["知识库检索与 RAG 问答", ["rag", "knowledge", "search", "文档", "知识库", "检索", "问答", "合同"]],
    ["业务流程与审批自动化", ["workflow", "approval", "自动化", "审批", "流程", "流转", "审核"]],
    ["数据看板与经营报表", ["dashboard", "report", "analytics", "报表", "看板", "统计", "分析"]],
    ["文件上传、解析与处理", ["upload", "file", "pdf", "excel", "上传", "文件", "解析"]],
    ["AI 助手交互与任务编排", ["chat", "assistant", "agent", "ai", "助手", "智能体", "对话"]],
    ["外部系统集成", ["jira", "github", "crm", "erp", "api", "integration", "集成", "接口"]],
  ];

  let epics = featureHints
    .filter(([, keys]) => keys.some((key) => lowered.includes(key)))
    .map(([name]) => name);
  if (!epics.length) {
    epics = ["核心业务流程", "用户操作界面", "后台管理与运营配置"];
  }

  const integrations = [
    ...new Set([...text.matchAll(/\b(GitHub|Jira|Slack|Notion|CRM|ERP|S3|OSS|Postgres|MySQL|Redis|Qdrant)\b/gi)].map((m) => m[1])),
  ];

  const risks = [];
  if (["compliance", "合规", "privacy", "隐私", "medical", "医疗", "finance", "金融", "legal", "法律"].some((word) => lowered.includes(word))) {
    risks.push("存在合规、隐私或行业监管要求，需要在需求阶段明确边界和审计策略。");
  }
  if (["legacy", "migration", "旧系统", "迁移", "历史数据"].some((word) => lowered.includes(word))) {
    risks.push("旧系统或历史数据迁移可能影响排期、数据质量和验收范围。");
  }
  if (["real-time", "realtime", "实时", "voice", "video", "语音", "视频"].some((word) => lowered.includes(word))) {
    risks.push("实时或多媒体能力需要额外做并发、延迟和容量压测。");
  }
  risks.push("高影响决策不能完全自动化，AI 输出必须保留人工复核和责任归档。");

  const stories = epics.flatMap((epic) => [
    `作为业务用户，我可以使用「${epic}」，从而在一个工作台内完成关键任务。`,
    `作为管理员，我可以配置「${epic}」的权限、规则和提示词，从而适配客户现场流程。`,
  ]);
  const sprints = Math.max(2, Math.min(6, Math.floor((epics.length + integrations.length + risks.length + 1) / 2)));
  return { epics, integrations, risks, stories, sprints };
}

function artifact(title, content) {
  return { title, content: content.trim(), kind: "markdown" };
}

function stage(id, name, owner, summary, artifacts) {
  return { id, name, owner, status: "completed", summary, artifacts };
}

function runDeterministicWorkflow(request) {
  const signals = extractSignals(request);
  const stack = request.tech_stack || "Next.js 前端、FastAPI 后端、Postgres、Redis 队列、对象存储、向量数据库";
  const issueDrafts = buildIssueDrafts(signals.epics);

  const stages = [
    stage("intake", "1. 需求接收与业务澄清", "需求分析 Agent", "把客户的口述需求、会议纪要和零散材料整理成可确认的项目简报。", [
      artifact("需求发现简报", `
## 业务目标
${request.goal}

## 客户背景
- 客户：${request.client_name || "内部项目"}
- 行业：${request.industry || "软件服务"}
- 目标用户：${request.target_users || "待确认"}

## 约束条件
${request.constraints || "暂未提供明确约束。建议补充预算、周期、合规、部署方式和运维边界。"}

## 初步范围信号
${bullets(signals.epics)}
`),
    ]),
    stage("product", "2. PRD 与需求 Backlog", "产品经理 Agent", "把需求简报转成模块、用户故事和验收标准，方便客户确认和研发排期。", [
      artifact("PRD Backlog", `
## 产品模块
${bullets(signals.epics)}

## 用户故事
${bullets(signals.stories)}

## 验收标准
${bullets([
  "每条核心流程都具备明确的开始状态、成功状态和失败状态。",
  "用户可以看到任务处理状态，并能在异常时重试或联系人工处理。",
  "关键 AI 输出必须展示来源、复核状态或置信说明。",
])}
`),
    ]),
    stage("architecture", "3. 技术方案与系统架构", "架构师 Agent", "定义产品架构、数据边界、集成方式和后续可扩展点。", [
      artifact("技术架构方案", `
## 推荐架构
\`\`\`text
Web 工作台
  -> API 网关 / FastAPI
      -> 登录认证与权限控制
      -> 工作流服务
      -> AI 编排服务
      -> 异步任务队列
  -> Postgres 保存业务数据
  -> 对象存储保存文件和生成物
  -> 向量数据库支持知识检索
  -> 日志、审计、调用成本与 Trace
\`\`\`

## 建议技术栈
${stack}

## 外部集成
${bullets(signals.integrations.length ? signals.integrations : ["暂未识别明确集成项。建议确认 GitHub、Jira、企业微信、CRM 或 ERP 需求。"])}

## 数据模型草案
- Organization、User、Role
- Project、Requirement、WorkflowRun
- Artifact、Review、Approval
- IntegrationCredential、AuditEvent、ModelUsage
`),
    ]),
    stage("delivery", "4. 研发实施计划", "研发负责人 Agent", "把方案拆成迭代计划和可落地的研发任务。", [
      artifact("迭代计划与 Issue 草案", `
## 交付计划
- 预估迭代数：${signals.sprints}
- Sprint 0：项目初始化、环境、认证、CI/CD、部署路径
- Sprint 1+：按产品模块交付核心功能
- 最后迭代：安全加固、文档、UAT、上线清单

## Issue 草案
${bullets(issueDrafts.map((issue) => `${issue.key}：${issue.title}。`))}
`),
    ]),
    stage("quality", "5. 测试、安全与代码评审", "QA 与 Review Agent", "生成风险清单、测试策略和上线前质量门禁。", [
      artifact("质量保障计划", `
## 风险登记
${bullets(signals.risks)}

## 测试策略
${bullets([
  "为核心服务、校验器、权限判断和任务状态流转补充单元测试。",
  "为 API 工作流和异步任务补充集成测试。",
  "为最高价值用户路径补充端到端测试。",
  "重点测试认证、文件上传、租户隔离和提示词注入风险。",
  "为 AI 输出结构、引用来源和失败重试建立回归测试。",
])}

## 完成定义
- 所有变更通过 PR 审查。
- CI 测试通过。
- 主流程具备可追踪日志。
- 面向用户的 AI 输出具备复核、重试和异常处理路径。
- 已记录部署回滚方案。
`),
    ]),
    stage("handoff", "6. 客户交付与运维闭环", "交付经理 Agent", "把研发成果整理成客户验收、上线和长期运营所需材料。", [
      artifact("交付清单", `
## 客户交付包
- 产品范围和验收标准
- 架构决策记录
- API 与集成文档
- 测试报告和已知限制
- 管理员手册和支持运行手册

## 运营机制
- 每周与客户进行交付评审
- 高影响 AI 决策必须人工确认
- 每月复盘模型质量和调用成本
- 建立任务失败、输出异常和集成故障的响应流程
`),
    ]),
  ];

  return {
    workflow_id: crypto.randomBytes(5).toString("hex"),
    created_at: new Date().toISOString(),
    project_name: request.project_name,
    client_name: request.client_name || "",
    stages,
    metrics: {
      estimated_sprints: signals.sprints,
      epics: signals.epics.length,
      stories: signals.stories.length,
      risks: signals.risks.length,
      integrations: signals.integrations.length,
    },
    backlog_issues: issueDrafts,
    generation_mode: "deterministic",
    next_actions: [
      "与客户确认范围边界、验收标准和优先级。",
      "根据技术架构创建代码仓库、环境配置和 CI/CD 流水线。",
      "把 Backlog 产物转换为 Jira 或 GitHub Issues。",
      "围绕集成、权限、数据迁移和部署方式开展技术澄清会。",
    ],
  };
}

const AGENT_DEFINITIONS = [
  {
    id: "intake",
    name: "1. 需求接收与业务澄清",
    owner: "需求分析 Agent",
    artifactTitle: "需求发现简报",
    mission: "澄清客户目标、业务背景、约束、范围边界、关键问题和初步风险。",
  },
  {
    id: "product",
    name: "2. PRD 与需求 Backlog",
    owner: "产品经理 Agent",
    artifactTitle: "PRD Backlog",
    mission: "把已澄清需求拆成产品模块、用户故事、验收标准、优先级和 MVP 范围。",
  },
  {
    id: "architecture",
    name: "3. 技术方案与系统架构",
    owner: "架构师 Agent",
    artifactTitle: "技术架构方案",
    mission: "设计系统架构、数据模型、集成边界、安全策略、部署方式和可扩展点。",
  },
  {
    id: "delivery",
    name: "4. 研发实施计划",
    owner: "研发负责人 Agent",
    artifactTitle: "迭代计划与 Issue 草案",
    mission: "拆解研发迭代、工程任务、依赖关系、交付节奏，并输出可创建到 GitHub/Jira 的 backlog_issues。",
    includeBacklog: true,
  },
  {
    id: "quality",
    name: "5. 测试、安全与代码评审",
    owner: "QA 与 Review Agent",
    artifactTitle: "质量保障计划",
    mission: "生成测试策略、安全风险、代码评审重点、质量门禁、回归测试和上线前检查。",
  },
  {
    id: "handoff",
    name: "6. 客户交付与运维闭环",
    owner: "交付经理 Agent",
    artifactTitle: "交付清单",
    mission: "整理客户验收材料、上线计划、运维机制、培训文档、支持流程和后续行动。",
    includeNextActions: true,
  },
];

async function callOpenAIJson(prompt) {
  const maxAttempts = Number(process.env.OPENAI_MAX_RETRIES || 3);
  const requestTimeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 45000);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await withTimeout(
        fetch(openAIResponsesUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
            input: prompt,
            text: { format: { type: "json_object" } },
            store: false,
          }),
        }),
        requestTimeoutMs,
        "OpenAI 请求"
      );

      if (response.ok) {
        const data = parseJsonLenient(await response.text());
        return parseJsonLenient(getOutputText(data));
      }

      const detail = await response.text();
      lastError = new Error(`OpenAI 生成失败：${response.status} ${detail}`);
      if (!isRetryableOpenAIStatus(response.status) || attempt === maxAttempts) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw lastError;
    }

    await sleep(500 * attempt);
  }

  throw lastError || new Error("OpenAI 生成失败：未知错误");
}

async function runStageAgent(agent, request, fallbackWorkflow, completedStages) {
  const fallbackStage = fallbackWorkflow.stages.find((item) => item.id === agent.id);
  const prompt = `
你是软件开发公司 AI 工作流中的「${agent.owner}」。

你的阶段：${agent.name}
你的任务：${agent.mission}

请只输出 JSON，不要输出 Markdown 代码围栏。JSON 字段必须包含：
{
  "summary": "一句话阶段摘要",
  "artifact_content": "Markdown 格式阶段产物"
}

${agent.includeBacklog ? `如果你是研发负责人 Agent，还必须输出：
{
  "backlog_issues": [
    {
      "key": "DEV-11",
      "title": "可直接作为 Issue 标题",
      "body": "Markdown，包含背景、实施要点、验收标准",
      "labels": ["ai-workflow"],
      "issue_type": "Task"
    }
  ]
}
要求 backlog_issues 生成 8 到 18 条。` : ""}

${agent.includeNextActions ? `如果你是交付经理 Agent，还可以输出：
{
  "next_actions": ["下一步行动"]
}` : ""}

约束：
- 所有内容使用简体中文。
- 内容要适合真实软件开发公司交付，不要写泛泛而谈的口号。
- 保留人工复核、审计、权限、安全和交付验收意识。
- 不要虚构已经完成的外部系统配置。

客户输入：
${JSON.stringify(request, null, 2)}

已经完成的前序 Agent 产物：
${JSON.stringify(completedStages.map((item) => ({
  name: item.name,
  owner: item.owner,
  summary: item.summary,
  artifact: item.artifacts?.[0]?.content,
})), null, 2)}

确定性基线，可参考但不要机械复制：
${JSON.stringify(fallbackStage, null, 2)}
`;

  const parsed = await callOpenAIJson(prompt);
  return {
    parsed,
    stage: stage(
      agent.id,
      agent.name,
      agent.owner,
      parsed.summary || fallbackStage.summary,
      [artifact(agent.artifactTitle, parsed.artifact_content || fallbackStage.artifacts[0].content)]
    ),
  };
}

async function generateWithOpenAI(request, fallbackWorkflow) {
  if (!process.env.OPENAI_API_KEY) return fallbackWorkflow;

  const stageById = {};
  let backlogIssues = fallbackWorkflow.backlog_issues;
  let nextActions = fallbackWorkflow.next_actions;
  const completed = [];

  async function runAndRecord(agent, contextStages) {
    updateWorkflowStatus({ current_agent: agent.owner });
    const result = await runStageAgent(agent, request, fallbackWorkflow, contextStages);
    stageById[agent.id] = result.stage;
    completed.push(agent.owner);
    updateWorkflowStatus({ completed_agents: completed.slice() });
    return result;
  }

  for (const agent of AGENT_DEFINITIONS) {
    const contextStages = AGENT_DEFINITIONS
      .filter((item) => stageById[item.id])
      .map((item) => stageById[item.id]);
    const result = await runAndRecord(agent, contextStages);
    if (agent.includeBacklog && Array.isArray(result.parsed.backlog_issues) && result.parsed.backlog_issues.length) {
      backlogIssues = result.parsed.backlog_issues;
    }
    if (agent.includeNextActions && Array.isArray(result.parsed.next_actions) && result.parsed.next_actions.length) {
      nextActions = result.parsed.next_actions;
    }
  }

  const stages = AGENT_DEFINITIONS.map((agent) => stageById[agent.id] || fallbackWorkflow.stages.find((item) => item.id === agent.id));

  return {
    ...fallbackWorkflow,
    stages,
    backlog_issues: backlogIssues,
    next_actions: nextActions,
    metrics: {
      ...fallbackWorkflow.metrics,
      stories: backlogIssues.length || fallbackWorkflow.metrics.stories,
    },
    generation_mode: "multi_agent",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    agent_team: AGENT_DEFINITIONS.map(({ id, owner }) => ({ id, owner })),
  };
}

async function improveWorkflowInBackground(request, fallback) {
  updateWorkflowStatus({
    running: true,
    current_agent: "规则引擎结果已返回，开始后台优化",
    completed_agents: [],
    started_at: new Date().toISOString(),
    finished_at: null,
    error: "",
    workflow_id: fallback.workflow_id,
  });
  try {
    const result = await generateWithOpenAI(request, fallback);
    lastRun = result;
    updateWorkflowStatus({
      running: false,
      current_agent: "完成",
      finished_at: new Date().toISOString(),
      error: "",
      workflow_id: result.workflow_id,
    });
  } catch (error) {
    updateWorkflowStatus({
      running: false,
      current_agent: "后台优化失败，已保留规则引擎结果",
      finished_at: new Date().toISOString(),
      error: error.message,
      workflow_id: fallback.workflow_id,
    });
    lastRun = {
      ...fallback,
      generation_mode: "deterministic_fallback",
      generation_error: error.message,
    };
  }
}

function runWorkflow(request) {
  const fallback = runDeterministicWorkflow(request);
  if (!process.env.OPENAI_API_KEY) return fallback;
  setTimeout(() => improveWorkflowInBackground(request, fallback), 0);
  return {
    ...fallback,
    generation_mode: "deterministic_pending",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  };
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join(", ")}`);
  }
}

function getIssueDrafts(workflow, limit) {
  if (!workflow) throw new Error("还没有生成工作流，请先运行 AI 工作流。");
  return (workflow.backlog_issues || []).slice(0, limit || 20);
}

async function createGitHubIssues(workflow, limit) {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPO"]);
  const issues = getIssueDrafts(workflow, limit);
  const results = [];
  for (const issue of issues) {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "software-dev-ai-workflow",
      },
      body: JSON.stringify({
        title: `[${issue.key}] ${issue.title}`,
        body: issue.body,
        labels: issue.labels || ["ai-workflow"],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`GitHub issue 创建失败：${response.status} ${JSON.stringify(data)}`);
    results.push({ key: issue.key, title: issue.title, url: data.html_url, number: data.number });
  }
  return results;
}

function jiraDescription(textValue) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: textValue }],
      },
    ],
  };
}

async function createJiraIssues(workflow, limit) {
  requireEnv(["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"]);
  const issues = getIssueDrafts(workflow, limit);
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
  const results = [];
  for (const issue of issues) {
    const response = await fetch(`${process.env.JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          project: { key: process.env.JIRA_PROJECT_KEY },
          summary: `[${issue.key}] ${issue.title}`,
          description: jiraDescription(issue.body),
          issuetype: { name: process.env.JIRA_ISSUE_TYPE || issue.issue_type || "Task" },
          labels: (issue.labels || ["ai-workflow"]).map((label) => label.replace(/[^A-Za-z0-9_-]/g, "-")),
        },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Jira issue 创建失败：${response.status} ${JSON.stringify(data)}`);
    results.push({
      key: issue.key,
      title: issue.title,
      jira_key: data.key,
      url: `${process.env.JIRA_BASE_URL.replace(/\/$/, "")}/browse/${data.key}`,
    });
  }
  return results;
}

function exportMarkdown(workflow) {
  if (!workflow) return "还没有生成任何工作流。\n";
  const lines = [
    `# ${workflow.project_name} AI 软件交付工作流`,
    "",
    `- 工作流 ID：\`${workflow.workflow_id}\``,
    `- 客户：${workflow.client_name || "内部项目"}`,
    `- 生成时间：${workflow.created_at}`,
    "",
    "## 指标",
    "",
    ...Object.entries(workflow.metrics).map(([key, value]) => `- ${titleLabel(key)}：${value}`),
    `- 生成模式：${workflow.generation_mode || "deterministic"}`,
  ];
  for (const item of workflow.stages) {
    lines.push("", `## ${item.name}`, "", item.summary, "");
    for (const output of item.artifacts) {
      lines.push(`### ${output.title}`, "", output.content, "");
    }
  }
  lines.push("## 下一步", "", ...workflow.next_actions.map((item) => `- ${item}`));
  lines.push("", "## Backlog Issues", "", ...(workflow.backlog_issues || []).map((issue) => `- ${issue.key}：${issue.title}`));
  return `${lines.join("\n").trim()}\n`;
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/static/index.html" : req.url;
  const filePath = path.join(__dirname, urlPath.replace(/^\/+/, ""));
  if (!filePath.startsWith(path.join(__dirname, "static"))) {
    text(res, 403, "禁止访问");
    return;
  }
  if (!fs.existsSync(filePath)) {
    text(res, 404, "未找到");
    return;
  }
  const ext = path.extname(filePath);
  const type = ext === ".css" ? "text/css" : ext === ".js" ? "application/javascript" : "text/html";
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, {
        status: "ok",
        app: "software-dev-ai-workflow",
        language: "zh-CN",
        llm_enabled: Boolean(process.env.OPENAI_API_KEY),
        ai_config_source: process.env.AI_CONFIG_SOURCE_ACTIVE || "env",
        ai_config_error: process.env.AI_CONFIG_SOURCE_ERROR || "",
        openai_base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com",
        openai_model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        github_enabled: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
        jira_enabled: Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY),
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/status") {
      json(res, 200, workflowStatus);
      return;
    }
    if (req.method === "POST" && req.url === "/api/workflows/run") {
      const body = await readBody(req);
      lastRun = await runWorkflow(body);
      json(res, 200, lastRun);
      return;
    }
    if (req.method === "POST" && req.url === "/api/integrations/github/issues") {
      const body = await readBody(req);
      const created = await createGitHubIssues(lastRun, body.limit);
      json(res, 200, { provider: "github", created });
      return;
    }
    if (req.method === "POST" && req.url === "/api/integrations/jira/issues") {
      const body = await readBody(req);
      const created = await createJiraIssues(lastRun, body.limit);
      json(res, 200, { provider: "jira", created });
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/latest/export") {
      text(res, 200, exportMarkdown(lastRun));
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/latest") {
      if (!lastRun) {
        json(res, 404, { error: "还没有生成任何工作流。" });
        return;
      }
      json(res, 200, lastRun);
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    text(res, 405, "不支持的请求方法");
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`软件开发公司 AI 工作流已启动：http://127.0.0.1:${PORT}`);
});
