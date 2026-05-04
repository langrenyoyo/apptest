const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

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
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
if not provider_id:
    current = conn.execute("select id from providers where app_type = 'codex' and is_current = 1 limit 1").fetchone()
    provider_id = current["id"] if current else None
if not provider_id:
    raise SystemExit("current Codex provider is not configured")
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
    if (parsed.model && !process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = parsed.model;
    process.env.AI_CONFIG_SOURCE_ACTIVE = "cc-switch";
  } catch (error) {
    process.env.AI_CONFIG_SOURCE_ACTIVE = "env";
    process.env.AI_CONFIG_SOURCE_ERROR = error.message;
  }
}

loadCcSwitchConfig();

const PORT = Number(process.env.PORT || 8901);
let lastRun = null;
let activeProjectId = "";
let managedProjects = [];
const previewRoot = path.join(__dirname, ".preview");
let workflowStatus = {
  running: false,
  current_agent: "",
  completed_agents: [],
  started_at: null,
  finished_at: null,
  error: "",
  workflow_id: "",
};

function makeProjectId() {
  return `project_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    client_name: project.client_name || "",
    industry: project.industry || "",
    status: project.status || "active",
    created_at: project.created_at,
    updated_at: project.updated_at,
    workflow_count: project.workflow_count || 0,
    latest_workflow_id: project.latest_workflow?.workflow_id || "",
    latest_workflow_at: project.latest_workflow?.created_at || "",
  };
}

function createManagedProject(input = {}) {
  const now = new Date().toISOString();
  const project = {
    id: input.id || makeProjectId(),
    name: input.name || input.project_name || "未命名项目",
    client_name: input.client_name || "",
    industry: input.industry || "",
    description: input.description || input.goal || "",
    status: input.status || "active",
    created_at: now,
    updated_at: now,
    workflow_count: 0,
    latest_workflow: null,
  };
  managedProjects.unshift(project);
  activeProjectId = project.id;
  return project;
}

function ensureManagedProject(input = {}) {
  if (input.project_id) {
    const existing = managedProjects.find((project) => project.id === input.project_id);
    if (existing) return existing;
  }
  const name = input.project_name || input.name;
  const existingByName = name
    ? managedProjects.find((project) => project.name === name && (project.client_name || "") === (input.client_name || ""))
    : null;
  if (existingByName) return existingByName;
  return createManagedProject(input);
}

function attachWorkflowToProject(workflow, input = {}) {
  const project = ensureManagedProject(input);
  project.name = input.project_name || project.name;
  project.client_name = input.client_name || project.client_name;
  project.industry = input.industry || project.industry;
  project.description = input.goal || project.description;
  project.updated_at = new Date().toISOString();
  project.workflow_count = (project.workflow_count || 0) + 1;
  project.latest_workflow = workflow;
  activeProjectId = project.id;
  workflow.project_id = project.id;
  workflow.project_status = project.status;
  return workflow;
}

createManagedProject({
  id: "default",
  name: "AI 合同审查门户",
  client_name: "某法律服务公司",
  industry: "法律科技",
  description: "默认演示项目",
});

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

function openAIChatCompletionsUrl() {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
  if (baseUrl.endsWith("/chat/completions")) return baseUrl;
  if (baseUrl.endsWith("/v1")) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
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

function normalizeIssueCard(issue, index = 0) {
  const key = issue.key || `DEV-${index + 1}`;
  const title = issue.title || "实施任务";
  const labels = Array.isArray(issue.labels) && issue.labels.length ? issue.labels : ["ai-workflow"];
  const category = labels.includes("frontend") ? "前端" : labels.includes("backend") ? "后端" : labels.includes("quality") ? "质量" : "全栈";
  const acceptanceCriteria = issue.acceptance_criteria?.length
    ? issue.acceptance_criteria
    : [
        "核心路径可被手动验证",
        "异常场景有明确错误提示或兜底处理",
        "关键逻辑具备最小测试或验证步骤",
      ];
  const implementationSteps = issue.implementation_steps?.length
    ? issue.implementation_steps
    : [
        "梳理现有代码入口和相关模块边界",
        "按最小可交付范围实现功能逻辑",
        "补充状态处理、错误处理和必要的日志",
        "执行验证命令并记录结果",
      ];
  const affectedFiles = issue.affected_files?.length
    ? issue.affected_files
    : category === "前端"
      ? ["static/app.js", "static/styles.css", "static/index.html"]
      : category === "后端"
        ? ["server.js", "workflow/engine.py", "workflow/models.py"]
        : ["server.js", "static/app.js", "static/styles.css"];
  const testPlan = issue.test_plan?.length
    ? issue.test_plan
    : ["运行 node --check server.js", "通过页面手动跑通主流程", "验证失败路径不会破坏已有规则结果"];
  const risks = issue.risks?.length ? issue.risks : ["需求边界可能需要结合真实用户流程二次确认"];
  const priority = issue.priority || (labels.includes("quality") ? "P1" : "P2");
  const estimate = issue.estimate || "0.5-1 day";
  const owner = issue.owner || (category === "前端" ? "Frontend Engineer" : category === "后端" ? "Backend Engineer" : "Full-stack Engineer");
  return {
    ...issue,
    key,
    title,
    labels,
    issue_type: issue.issue_type || "Task",
    priority,
    owner,
    estimate,
    affected_files: affectedFiles,
    implementation_steps: implementationSteps,
    acceptance_criteria: acceptanceCriteria,
    test_plan: testPlan,
    risks,
    body: issue.body || "",
  };
}

function formatIssueCardBody(issue) {
  const card = normalizeIssueCard(issue);
  const list = (items) => (items || []).map((item) => `- ${item}`).join("\n");
  return [
    card.body ? card.body.trim() : `## 背景\n${card.title}`,
    "",
    "## 实施任务卡",
    "",
    `- 优先级：${card.priority}`,
    `- 建议负责人：${card.owner}`,
    `- 预估工作量：${card.estimate}`,
    "",
    "### 涉及文件",
    list(card.affected_files),
    "",
    "### 实施步骤",
    list(card.implementation_steps),
    "",
    "### 验收标准",
    list(card.acceptance_criteria),
    "",
    "### 测试计划",
    list(card.test_plan),
    "",
    "### 风险与注意事项",
    list(card.risks),
  ].join("\n");
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
    backlog_issues: issueDrafts.map(normalizeIssueCard),
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

async function callOpenAIJson(prompt) {
  const maxAttempts = Number(process.env.OPENAI_MAX_RETRIES || 3);
  const requestTimeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 45000);
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  let lastError = null;

  async function requestJson(url, body, label) {
    const response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      }),
      requestTimeoutMs,
      `${label} request`
    );
    const responseBody = await response.text();
    if (!response.ok) {
      const error = new Error(`${label} failed: ${response.status} ${responseBody}`);
      error.status = response.status;
      throw error;
    }
    const data = parseJsonLenient(responseBody);
    const outputText = label === "OpenAI Chat" ? data.choices?.[0]?.message?.content || "" : getOutputText(data);
    return parseJsonLenient(outputText);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      try {
        return await requestJson(
          openAIResponsesUrl(),
          {
            model,
            input: prompt,
            text: { format: { type: "json_object" } },
            store: false,
          },
          "OpenAI Responses"
        );
      } catch (responsesError) {
        lastError = responsesError;
        if (!isRetryableOpenAIStatus(responsesError.status)) throw responsesError;
      }

      return await requestJson(
        openAIChatCompletionsUrl(),
        {
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        },
        "OpenAI Chat"
      );
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw lastError;
    }
    await sleep(500 * attempt);
  }

  throw lastError || new Error("OpenAI generation failed");
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
      "issue_type": "Task",
      "priority": "P1",
      "owner": "Full-stack Engineer",
      "estimate": "0.5-1 day",
      "affected_files": ["server.js", "static/app.js"],
      "implementation_steps": ["梳理现有入口", "实现最小功能", "补充错误处理"],
      "acceptance_criteria": ["核心路径可验证", "失败路径有提示"],
      "test_plan": ["运行语法检查", "手动验证主流程"],
      "risks": ["依赖外部配置或真实数据"]
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
    backlog_issues: backlogIssues.map(normalizeIssueCard),
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
  return (workflow.backlog_issues || []).map(normalizeIssueCard).slice(0, limit || 20);
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
        body: formatIssueCardBody(issue),
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
          description: jiraDescription(formatIssueCardBody(issue)),
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

function findIssueCard(workflow, issueKey) {
  if (!workflow) throw new Error("还没有生成工作流，请先运行 AI 工作流。");
  const issues = (workflow.backlog_issues || []).map(normalizeIssueCard);
  const issue = issues.find((item) => item.key === issueKey);
  if (!issue) throw new Error(`未找到任务卡：${issueKey}`);
  return issue;
}

async function generateImplementationPlan(workflow, issueKey) {
  if (!process.env.OPENAI_API_KEY) throw new Error("未启用真实 Agent，无法生成代码实施方案。");
  const issue = findIssueCard(workflow, issueKey);
  const prompt = `
你是资深软件工程负责人。请基于下面的实施任务卡，生成一份“代码自动化实施方案”。

要求：
- 只输出 JSON，不要输出 Markdown 代码围栏。
- 不要声称已经修改代码。
- 方案必须适合交给代码 Agent 或开发者执行。
- 如果任务卡的涉及文件只是推测，请在 risks 中说明需要先确认真实代码路径。

JSON 字段：
{
  "issue_key": "${issue.key}",
  "title": "任务标题",
  "summary": "一句话说明实施目标",
  "change_plan": [
    {
      "file": "建议修改的文件路径",
      "reason": "为什么改这个文件",
      "changes": ["具体修改点"]
    }
  ],
  "steps": ["按顺序执行的实现步骤"],
  "test_commands": ["可执行或手动验证命令"],
  "acceptance_checks": ["完成后如何验收"],
  "risks": ["风险或需要人工确认的点"],
  "rollback_plan": ["如何回滚或降低风险"]
}

任务卡：
${JSON.stringify(issue, null, 2)}

当前工作流上下文：
${JSON.stringify({
  project_name: workflow.project_name,
  client_name: workflow.client_name,
  metrics: workflow.metrics,
  generation_mode: workflow.generation_mode,
}, null, 2)}
`;
  const plan = await callOpenAIJson(prompt);
  return {
    issue,
    plan: {
      issue_key: issue.key,
      title: issue.title,
      ...plan,
      generated_at: new Date().toISOString(),
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    },
  };
}

async function generatePatchDraft(workflow, issueKey, implementationPlan = null) {
  if (!process.env.OPENAI_API_KEY) throw new Error("未启用真实 Agent，无法生成 patch 草案。");
  const issue = findIssueCard(workflow, issueKey);
  const prompt = `
你是资深代码生成 Agent。请基于任务卡和实施方案，生成“patch 草案”。

重要边界：
- 只输出 JSON，不要输出 Markdown 代码围栏。
- 这是草案，不会自动应用；不要声称已经修改文件。
- diff 必须尽量使用 unified diff 风格。
- 如果缺少真实代码上下文，请生成保守 patch 草案，并在 assumptions/risks 中说明需要人工确认。
- 不要发明密钥、真实外部账号或不可验证的配置。

JSON 字段：
{
  "issue_key": "${issue.key}",
  "title": "任务标题",
  "summary": "这个 patch 草案要做什么",
  "files": [
    {
      "path": "文件路径",
      "purpose": "修改目的",
      "patch": "unified diff 草案"
    }
  ],
  "test_commands": ["测试或验证命令"],
  "manual_checks": ["人工检查点"],
  "assumptions": ["假设"],
  "risks": ["风险"],
  "rollback_plan": ["回滚方式"]
}

任务卡：
${JSON.stringify(issue, null, 2)}

实施方案：
${JSON.stringify(implementationPlan || {}, null, 2)}

工作流上下文：
${JSON.stringify({
  project_name: workflow.project_name,
  client_name: workflow.client_name,
  generation_mode: workflow.generation_mode,
}, null, 2)}
`;
  const strictPatchPrompt = `${prompt}

Hard requirement for every files[].patch:
- Output a real git-apply compatible unified diff only.
- The patch string must contain file headers like "diff --git a/path b/path" OR at minimum "--- a/path" and "+++ b/path".
- The patch string must contain at least one "@@ ... @@" hunk.
- Do not put Markdown fences, prose, bullets, JSON, or explanations inside files[].patch.
- If you cannot produce a valid diff, return files: [] and explain the blocker in risks.
`;
  const patchDraft = await callOpenAIJson(strictPatchPrompt);
  const quality = patchQualityReport(patchDraft);
  return {
    issue,
    patch: {
      issue_key: issue.key,
      title: issue.title,
      ...patchDraft,
      patch_quality: quality,
      generated_at: new Date().toISOString(),
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      status: quality.valid ? "draft_only" : "invalid_diff",
    },
  };
}

async function generateCodeDraft(workflow, issueKey) {
  const planResult = await generateImplementationPlan(workflow, issueKey);
  const patchResult = await generatePatchDraft(workflow, issueKey, planResult.plan);
  return {
    issue: planResult.issue,
    plan: planResult.plan,
    patch: patchResult.patch,
    status: "draft_only",
    generated_at: new Date().toISOString(),
  };
}

function validatePatchPaths(patchText) {
  const root = path.resolve(__dirname);
  const fileMatches = [...String(patchText).matchAll(/^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/gm)];
  for (const match of fileMatches) {
    const filePath = match[1].trim();
    if (!filePath || filePath === "/dev/null") continue;
    if (filePath.includes("\0") || path.isAbsolute(filePath)) {
      throw new Error(`Patch 包含非法路径：${filePath}`);
    }
    const resolved = path.resolve(root, filePath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`Patch 路径越界：${filePath}`);
    }
  }
}

function runGitApply(args, patchText) {
  return spawnSync("git", args, {
    cwd: __dirname,
    input: patchText,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runGitApplyIn(cwd, args, patchText) {
  return spawnSync("git", args, {
    cwd,
    input: patchText,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function cleanPatchText(rawPatch) {
  let textValue = String(rawPatch || "").trim();
  textValue = textValue.replace(/^```(?:diff|patch)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const diffStart = textValue.search(/^(diff --git|--- |\+\+\+ )/m);
  if (diffStart > 0) textValue = textValue.slice(diffStart).trim();
  return textValue;
}

function looksLikeUnifiedDiff(patchText) {
  return /^(diff --git|--- )/m.test(patchText) && /^\+\+\+ /m.test(patchText) && /^@@ /m.test(patchText);
}

function patchQualityReport(patchDraft) {
  const files = patchDraft?.files || [];
  const file_reports = files.map((file) => {
    const cleaned = cleanPatchText(file.patch);
    const valid = looksLikeUnifiedDiff(cleaned);
    return {
      path: file.path || "",
      valid_unified_diff: valid,
      reason: valid ? "" : "patch 字段必须包含 diff --git 或 ---、+++、@@ hunk；当前内容不是可 git apply 的 unified diff。",
    };
  });
  return {
    valid: file_reports.length > 0 && file_reports.every((item) => item.valid_unified_diff),
    file_reports,
  };
}

function patchTextFromDraft(patchDraft) {
  const files = patchDraft?.files || [];
  if (!files.length) throw new Error("Patch 草案没有可预览的文件。");
  const patches = files.map((file) => cleanPatchText(file.patch)).filter(Boolean);
  if (!patches.length) throw new Error("Patch 草案没有 diff 内容。");
  const patchText = `${patches.join("\n\n")}\n`;
  if (!looksLikeUnifiedDiff(patchText)) {
    throw new Error("生成的 Patch 不是可应用的 unified diff，无法预览。请重新生成 Patch 草案，或要求 AI 输出包含 ---、+++ 和 @@ 的 git apply 格式 diff。");
  }
  validatePatchPaths(patchText);
  return patchText;
}

function createUiPreview(patchDraft) {
  let patchText = patchTextFromDraft(patchDraft);
  const previewId = `ui_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const previewDir = path.join(previewRoot, previewId);
  fs.mkdirSync(previewDir, { recursive: true });

  fs.cpSync(path.join(__dirname, "static"), path.join(previewDir, "static"), { recursive: true });
  const previewIndexPath = path.join(previewDir, "static", "index.html");
  for (const fileName of ["server.js", "package.json"]) {
    const source = path.join(__dirname, fileName);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(previewDir, fileName));
  }

  let check = runGitApplyIn(previewDir, ["apply", "--check", "--recount", "--whitespace=nowarn", "-"], patchText);
  if (check.status !== 0 && /No valid patches in input/i.test(check.stderr || check.stdout || "")) {
    patchText = cleanPatchText(patchText);
    check = runGitApplyIn(previewDir, ["apply", "--check", "--recount", "--whitespace=nowarn", "-"], patchText);
  }
  if (check.status !== 0) {
    throw new Error(`UI 预览检查失败：${check.stderr || check.stdout || "git apply --check failed"}。请重新生成 Patch 草案，当前 diff 可能存在 hunk 上下文或行号损坏。`);
  }

  const applied = runGitApplyIn(previewDir, ["apply", "--recount", "--whitespace=nowarn", "-"], patchText);
  if (applied.status !== 0) {
    throw new Error(`UI 预览生成失败：${applied.stderr || applied.stdout || "git apply failed"}`);
  }

  if (fs.existsSync(previewIndexPath)) {
    const html = fs
      .readFileSync(previewIndexPath, "utf8")
      .replaceAll('href="/static/', `href="/preview/${previewId}/static/`)
      .replaceAll('src="/static/', `src="/preview/${previewId}/static/`);
    const previewStyles = `
      <style>
        body.ui-preview-mode .form-panel,
        body.ui-preview-mode .project-manager,
        body.ui-preview-mode #githubButton,
        body.ui-preview-mode #jiraButton,
        body.ui-preview-mode #runButton {
          display: none !important;
        }
        body.ui-preview-mode .workspace {
          grid-template-columns: minmax(0, 1fr) !important;
        }
        body.ui-preview-mode .results {
          grid-column: 1 / -1;
        }
        body.ui-preview-mode .toolbar .actions {
          display: none !important;
        }
        body.ui-preview-mode .shell {
          padding: 20px;
        }
      </style>
    `;
    const previewHtml = html
      .replace("<body>", '<body class="ui-preview-mode">')
      .replace("</head>", `${previewStyles}</head>`);
    fs.writeFileSync(previewIndexPath, previewHtml, "utf8");
  }

  return {
    preview_id: previewId,
    preview_url: `/preview/${previewId}/`,
    files: (patchDraft.files || []).map((file) => file.path).filter(Boolean),
    generated_at: new Date().toISOString(),
    message: "UI 预览已生成，尚未修改当前工作区。",
  };
}

function runGit(args) {
  return spawnSync("git", args, {
    cwd: __dirname,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function gitOutput(args) {
  const result = runGit(args);
  if (result.status !== 0) return (result.stderr || result.stdout || "").trim();
  return (result.stdout || "").trim();
}

function collectAppliedDiffSummary(files, testCommands = [], patchText = "") {
  const cleanFiles = [...new Set((files || []).filter(Boolean))];
  const diffArgs = cleanFiles.length ? ["diff", "--unified=3", "--", ...cleanFiles] : ["diff", "--unified=3"];
  const statArgs = cleanFiles.length ? ["diff", "--stat", "--", ...cleanFiles] : ["diff", "--stat"];
  const nameArgs = cleanFiles.length ? ["diff", "--name-only", "--", ...cleanFiles] : ["diff", "--name-only"];
  const changedFiles = gitOutput(nameArgs).split(/\r?\n/).filter(Boolean);
  const diff = gitOutput(diffArgs);
  return {
    diff_stat: gitOutput(statArgs),
    changed_files: changedFiles.length ? changedFiles : cleanFiles,
    diff: diff || patchText,
    suggested_tests: testCommands.length ? testCommands : ["node --check server.js", "node --check static/app.js", "手动验证相关页面流程"],
  };
}

function applyPatchDraft(patchDraft) {
  const files = patchDraft?.files || [];
  if (!files.length) throw new Error("Patch 草案没有可应用的文件。");
  const patches = files.map((file) => String(file.patch || "").trim()).filter(Boolean);
  if (!patches.length) throw new Error("Patch 草案没有 diff 内容。");
  const patchText = `${patches.join("\n\n")}\n`;
  validatePatchPaths(patchText);

  const check = runGitApply(["apply", "--check", "--recount", "--whitespace=nowarn", "-"], patchText);
  if (check.status !== 0) {
    throw new Error(`Patch 检查失败：${check.stderr || check.stdout || "git apply --check failed"}`);
  }

  const applied = runGitApply(["apply", "--recount", "--whitespace=nowarn", "-"], patchText);
  if (applied.status !== 0) {
    throw new Error(`Patch 应用失败：${applied.stderr || applied.stdout || "git apply failed"}`);
  }

  const appliedFiles = files.map((file) => file.path).filter(Boolean);
  const diffSummary = collectAppliedDiffSummary(appliedFiles, patchDraft.test_commands || [], patchText);

  return {
    issue_key: patchDraft.issue_key || "",
    status: "applied",
    applied_at: new Date().toISOString(),
    files: appliedFiles,
    message: "Patch 已应用到本地工作区，尚未提交。",
    ...diffSummary,
  };
}

function reversePatchDraft(patchDraft) {
  const files = patchDraft?.files || [];
  if (!files.length) throw new Error("Patch 草案没有可撤销的文件。");
  const patches = files.map((file) => String(file.patch || "").trim()).filter(Boolean);
  if (!patches.length) throw new Error("Patch 草案没有 diff 内容。");
  const patchText = `${patches.join("\n\n")}\n`;
  validatePatchPaths(patchText);

  const check = runGitApply(["apply", "--reverse", "--check", "--recount", "--whitespace=nowarn", "-"], patchText);
  if (check.status !== 0) {
    throw new Error(`Patch 撤销检查失败：${check.stderr || check.stdout || "git apply --reverse --check failed"}`);
  }

  const reversed = runGitApply(["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"], patchText);
  if (reversed.status !== 0) {
    throw new Error(`Patch 撤销失败：${reversed.stderr || reversed.stdout || "git apply --reverse failed"}`);
  }

  const filesChanged = files.map((file) => file.path).filter(Boolean);
  return {
    issue_key: patchDraft.issue_key || "",
    status: "reverted",
    reverted_at: new Date().toISOString(),
    files: filesChanged,
    message: "Patch 已从本地工作区撤销，尚未提交。",
    ...collectAppliedDiffSummary(filesChanged, patchDraft.test_commands || [], ""),
  };
}

async function generateCommitDraft(patchDraft, applyResult = null) {
  if (!process.env.OPENAI_API_KEY) throw new Error("未启用真实 Agent，无法生成提交说明。");
  const prompt = `
你是资深工程负责人。请基于 patch 草案和应用后的 diff 摘要，生成提交说明与 PR 草稿。

要求：
- 只输出 JSON，不要输出 Markdown 代码围栏。
- 不要声称已经提交、推送或创建 PR。
- 文案应适合人工审查后复制到 Git。

JSON 字段：
{
  "commit_message": "type(scope): concise summary",
  "pr_title": "PR 标题",
  "pr_description": "Markdown 格式 PR 描述，包含背景、变更、测试、风险",
  "review_checklist": ["审查点"],
  "recommended_tests": ["建议执行的测试命令"],
  "risk_notes": ["风险说明"]
}

Patch 草案：
${JSON.stringify(patchDraft || {}, null, 2)}

应用结果：
${JSON.stringify(applyResult || {}, null, 2)}
`;
  const draft = await callOpenAIJson(prompt);
  return {
    ...draft,
    generated_at: new Date().toISOString(),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    status: "draft_only",
  };
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
  lines.push("", "## Backlog Issues", "", ...(workflow.backlog_issues || []).map((issue) => formatIssueCardBody(issue)));
  return `${lines.join("\n").trim()}\n`;
}

function serveStatic(req, res) {
  if (req.url.startsWith("/preview/")) {
    const parts = req.url.split("?")[0].split("/").filter(Boolean);
    const previewId = parts[1] || "";
    const rest = parts.slice(2).join("/") || "static/index.html";
    if (!/^ui_[A-Za-z0-9_-]+$/.test(previewId)) {
      text(res, 403, "禁止访问");
      return;
    }
    const previewBase = path.join(previewRoot, previewId);
    const filePath = path.resolve(previewBase, rest);
    if (!filePath.startsWith(previewBase + path.sep) && filePath !== previewBase) {
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
    return;
  }

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
        openai_primary_api: "responses",
        openai_fallback_api: "chat_completions",
        github_enabled: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
        jira_enabled: Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY),
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/status") {
      json(res, 200, workflowStatus);
      return;
    }
    if (req.method === "GET" && req.url === "/api/projects") {
      json(res, 200, {
        active_project_id: activeProjectId,
        projects: managedProjects.map(projectSummary),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/projects") {
      const body = await readBody(req);
      const project = createManagedProject(body);
      json(res, 200, {
        active_project_id: activeProjectId,
        project: projectSummary(project),
        projects: managedProjects.map(projectSummary),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/projects/select") {
      const body = await readBody(req);
      const project = managedProjects.find((item) => item.id === body.project_id);
      if (!project) {
        json(res, 404, { error: "未找到项目" });
        return;
      }
      activeProjectId = project.id;
      lastRun = project.latest_workflow || lastRun;
      json(res, 200, {
        active_project_id: activeProjectId,
        project: projectSummary(project),
        latest_workflow: project.latest_workflow || null,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/workflows/run") {
      const body = await readBody(req);
      lastRun = attachWorkflowToProject(await runWorkflow(body), body);
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
    if (req.method === "POST" && req.url === "/api/implementation/plan") {
      const body = await readBody(req);
      const result = await generateImplementationPlan(lastRun, body.issue_key);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/patch-draft") {
      const body = await readBody(req);
      const result = await generatePatchDraft(lastRun, body.issue_key, body.implementation_plan);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/generate-code") {
      const body = await readBody(req);
      const result = await generateCodeDraft(lastRun, body.issue_key);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/apply-patch") {
      const body = await readBody(req);
      const result = applyPatchDraft(body.patch);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/ui-preview") {
      const body = await readBody(req);
      const result = createUiPreview(body.patch);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/revert-patch") {
      const body = await readBody(req);
      const result = reversePatchDraft(body.patch);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/commit-draft") {
      const body = await readBody(req);
      const result = await generateCommitDraft(body.patch, body.apply_result);
      json(res, 200, result);
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/latest/export") {
      const activeProject = managedProjects.find((project) => project.id === activeProjectId);
      text(res, 200, exportMarkdown(activeProject?.latest_workflow || lastRun));
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/latest") {
      const activeProject = managedProjects.find((project) => project.id === activeProjectId);
      const latestWorkflow = activeProject?.latest_workflow || lastRun;
      if (!latestWorkflow) {
        json(res, 404, { error: "还没有生成任何工作流。" });
        return;
      }
      json(res, 200, latestWorkflow);
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
