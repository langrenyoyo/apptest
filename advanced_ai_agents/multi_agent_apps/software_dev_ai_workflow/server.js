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
const dataRoot = path.join(__dirname, ".data");
const stateFile = path.join(dataRoot, "state.json");
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

function defaultProjectInput() {
  return {
    id: "default",
    name: "AI 合同审查门户",
    project_name: "AI 合同审查门户",
    client_name: "某法律服务公司",
    industry: "法律科技",
    description: "默认演示项目",
  };
}

function persistState() {
  const state = {
    version: 1,
    active_project_id: activeProjectId,
    last_run_id: lastRun?.workflow_id || "",
    workflow_status: workflowStatus,
    projects: managedProjects,
    saved_at: new Date().toISOString(),
  };
  fs.mkdirSync(dataRoot, { recursive: true });
  const tempFile = `${stateFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, stateFile);
}

function loadState() {
  if (!fs.existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    managedProjects = Array.isArray(state.projects) ? state.projects : [];
    let stateChanged = false;
    for (const project of managedProjects) {
      if (sanitizeWorkflowMojibake(project.latest_workflow)) stateChanged = true;
    }
    activeProjectId = state.active_project_id || managedProjects[0]?.id || "";
    const activeProject = managedProjects.find((project) => project.id === activeProjectId) || managedProjects[0] || null;
    if (activeProject) activeProjectId = activeProject.id;
    lastRun = activeProject?.latest_workflow || managedProjects.find((project) => project.latest_workflow)?.latest_workflow || null;
    if (state.workflow_status && typeof state.workflow_status === "object") {
      workflowStatus = { ...workflowStatus, ...state.workflow_status, running: false };
    }
    if (stateChanged) persistState();
    return managedProjects.length > 0;
  } catch (error) {
    console.warn(`本地状态读取失败，将使用默认演示项目：${error.message}`);
    managedProjects = [];
    activeProjectId = "";
    lastRun = null;
    return false;
  }
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

function hasQuestionMarkMojibake(value) {
  return typeof value === "string" && /\?{2,}/.test(value);
}

function cleanTextInput(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const textValue = String(value);
  return hasQuestionMarkMojibake(textValue) ? fallback : textValue;
}

function hasMeaningfulText(value) {
  return typeof value === "string" && value.trim().length > 0 && !hasQuestionMarkMojibake(value);
}

function cleanMojibakeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const textValue = String(value);
  return hasQuestionMarkMojibake(textValue) ? fallback : textValue;
}

function cleanMojibakeBlock(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const textValue = String(value);
  if (!hasQuestionMarkMojibake(textValue)) return textValue;
  return textValue
    .split(/\r?\n/)
    .map((line) => (hasQuestionMarkMojibake(line) ? fallback : line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeWorkflowMojibake(workflow) {
  if (!workflow) return false;
  let changed = false;
  const feedbackFallback = "历史反馈因本地编码异常已清理，请重新填写。";
  workflow.delivery_exports = workflowExportVersions(workflow).map((record) => {
    const nextRecord = { ...record };
    if (hasQuestionMarkMojibake(nextRecord.customer_feedback)) {
      nextRecord.customer_feedback = "";
      changed = true;
    }
    return nextRecord;
  });
  if (Array.isArray(workflow.backlog_issues)) {
    workflow.backlog_issues = workflow.backlog_issues.map((issue) => {
      const nextIssue = { ...issue };
      if (hasQuestionMarkMojibake(nextIssue.customer_feedback)) {
        nextIssue.customer_feedback = feedbackFallback;
        changed = true;
      }
      if (hasQuestionMarkMojibake(nextIssue.body)) {
        nextIssue.body = cleanMojibakeBlock(nextIssue.body, feedbackFallback);
        changed = true;
      }
      return nextIssue;
    });
  }
  return changed;
}

function cleanWorkflowInput(input = {}) {
  const rawName = hasMeaningfulText(input.name) ? input.name.trim() : "";
  const rawProjectName = hasMeaningfulText(input.project_name) ? input.project_name.trim() : "";
  const projectName = cleanTextInput(rawProjectName || rawName, "AI 合同审查门户");
  const displayName = cleanTextInput(rawName || rawProjectName, projectName || "未命名项目");
  return {
    ...input,
    name: displayName,
    project_name: projectName,
    client_name: cleanTextInput(input.client_name, "某法律服务公司"),
    industry: cleanTextInput(input.industry, "法律科技"),
    goal: cleanTextInput(input.goal, "建设一个安全的 Web 应用，支持客户需求管理、AI 交付工作流、产品原型生成和沙盒测试。"),
    source_material: cleanTextInput(input.source_material, "需要登录、项目列表、需求录入、AI 工作流、产品原型、Mock API、沙盒测试和交付 Backlog。"),
    constraints: cleanTextInput(input.constraints, "必须支持本地演示、无外部服务兜底、审计日志、人工审批和可回归测试。"),
    target_users: cleanTextInput(input.target_users, "产品经理、研发负责人、前端工程师、测试工程师、交付经理"),
    tech_stack: cleanTextInput(input.tech_stack, "Node.js、HTML、CSS、JavaScript、Mock API、内存数据"),
  };
}

function createManagedProject(input = {}) {
  input = cleanWorkflowInput(input);
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
  persistState();
  return project;
}

function ensureManagedProject(input = {}, options = {}) {
  input = cleanWorkflowInput(input);
  if (input.project_id) {
    const existing = managedProjects.find((project) => project.id === input.project_id);
    if (existing) return existing;
  }
  if (options.preferActive && activeProjectId) {
    const active = managedProjects.find((project) => project.id === activeProjectId);
    if (active) return active;
  }
  const name = input.project_name || input.name;
  const existingByName = name
    ? managedProjects.find((project) => project.name === name && (project.client_name || "") === (input.client_name || ""))
    : null;
  if (existingByName) return existingByName;
  return createManagedProject(input);
}

function attachWorkflowToProject(workflow, input = {}) {
  input = cleanWorkflowInput(input);
  const project = ensureManagedProject(input, { preferActive: Boolean(input.project_id) });
  project.name = input.project_name || input.name || project.name;
  project.client_name = input.client_name || project.client_name;
  project.industry = input.industry || project.industry;
  project.description = input.goal || project.description;
  project.updated_at = new Date().toISOString();
  project.workflow_count = (project.workflow_count || 0) + 1;
  project.latest_workflow = workflow;
  activeProjectId = project.id;
  workflow.project_id = project.id;
  workflow.project_status = project.status;
  persistState();
  return workflow;
}

function activeProject() {
  return managedProjects.find((project) => project.id === activeProjectId) || managedProjects[0] || null;
}

function currentWorkflow() {
  return activeProject()?.latest_workflow || lastRun;
}

function saveWorkflowMutation(workflow) {
  if (!workflow) return workflow;
  lastRun = workflow;
  const project = managedProjects.find((item) => item.id === (workflow.project_id || activeProjectId)) || activeProject();
  if (project) {
    project.latest_workflow = workflow;
    project.latest_workflow_id = workflow.workflow_id;
    project.updated_at = new Date().toISOString();
    activeProjectId = project.id;
  }
  persistState();
  return workflow;
}

if (!loadState()) {
  createManagedProject(defaultProjectInput());
}

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

function html(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    timeoutId = setTimeout(() => reject(new Error(`${label} 等待 AI 返回超时：超过 ${Math.round(ms / 1000)} 秒未返回。可继续加大 OPENAI_REQUEST_TIMEOUT_MS，或查看服务商是否已返回 4xx/5xx 错误。`)), ms);
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

function slugifyModuleName(value, fallback = "module") {
  const textValue = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return textValue || fallback;
}

function sandboxContractFor(epic, index) {
  const slug = slugifyModuleName(epic, `module-${index + 1}`);
  const route = `/sandbox/${slug}`;
  const apiBase = `/api/sandbox/${slug}`;
  return {
    slug,
    route,
    api_base: apiBase,
    mock_data_id: `${slug}-demo-001`,
    mock_data: {
      id: `${slug}-demo-001`,
      title: `${epic}演示数据`,
      status: "pending_review",
      owner: "演示用户",
      updated_at: "2026-05-04T10:00:00.000Z",
      items: [
        { label: "待处理", value: 12 },
        { label: "处理中", value: 5 },
        { label: "已完成", value: 28 },
      ],
    },
    api_contract: [
      `GET ${apiBase}/summary -> 返回模块指标、状态分布和最近活动`,
      `GET ${apiBase}/items?q=&status= -> 返回可筛选列表`,
      `POST ${apiBase}/items -> 使用 mock schema 创建一条演示记录`,
      `POST ${apiBase}/items/:id/submit -> 推进到下一状态并返回审计事件`,
    ],
    sandbox_tests: [
      "node --check server.js",
      "node --check static/app.js",
      `手动打开 ${route}，确认页面可独立预览`,
      `调用 GET ${apiBase}/summary，确认返回 mock 数据`,
    ],
    manual_checks: [
      "沙盒页面具备加载态、空状态、失败提示和成功反馈",
      "列表搜索和状态筛选不会影响其他模块",
      "主要操作只修改当前模块 mock 数据",
      "生成代码后可通过 UI 预览或 /preview 链接独立验收",
    ],
  };
}

buildIssueDrafts = function buildSandboxReadyIssueDrafts(epics) {
  return epics.flatMap((epic, index) => {
    const sandbox = sandboxContractFor(epic, index);
    return [
      {
        key: `MOD-${index + 1}1`,
        title: `模块「${epic}」沙盒页面与交互原型`,
        body: `## 目标\n为「${epic}」建立可独立访问的沙盒页面，先用 mock 数据跑通主要用户路径，方便生成代码后在隔离页面验收。\n\n## 沙盒入口\n- 页面：${sandbox.route}\n- Mock 数据：${sandbox.mock_data_id}\n\n## 交付边界\n只实现当前模块的页面结构、状态、事件处理和 mock 数据，不接真实外部系统。`,
        labels: ["ai-workflow", "module", "frontend", "sandbox"],
        issue_type: "Task",
        priority: index === 0 ? "P1" : "P2",
        owner: "Frontend Engineer",
        estimate: "0.5-1 day",
        affected_files: ["static/index.html", "static/app.js", "static/styles.css"],
        implementation_steps: [
          `新增或复用 ${sandbox.route} 沙盒入口`,
          "定义模块级 view state：loading、empty、ready、error、submitting",
          "使用 mock_data 渲染指标、列表、详情和主要操作",
          "为搜索、筛选、提交、重试补齐前端事件",
          "把沙盒入口接入产品原型和 UI 预览链路",
        ],
        acceptance_criteria: [
          `访问 ${sandbox.route} 可独立看到模块页面`,
          "无真实 API Key 和外部服务时仍可完成演示",
          "主要操作会更新 mock 状态并显示反馈",
          "移动端和桌面端布局不重叠、不溢出",
        ],
        test_plan: sandbox.sandbox_tests,
        risks: ["沙盒 mock 字段后续需要和真实 API schema 对齐"],
        sandbox,
      },
      {
        key: `MOD-${index + 1}2`,
        title: `模块「${epic}」Mock API 与测试夹具`,
        body: `## 目标\n为「${epic}」提供可被前端和自动化测试复用的 Mock API 契约，生成代码后可在无数据库、无外部依赖的情况下完成沙盒测试。\n\n## API 契约\n${sandbox.api_contract.map((item) => `- ${item}`).join("\n")}`,
        labels: ["ai-workflow", "module", "backend", "mock-api", "sandbox"],
        issue_type: "Task",
        priority: "P1",
        owner: "Backend Engineer",
        estimate: "0.5-1 day",
        affected_files: ["server.js"],
        implementation_steps: [
          `新增 ${sandbox.api_base} 命名空间下的 mock API`,
          "把 mock 数据放入内存 fixture，避免依赖真实数据库",
          "统一返回 success、data、error、request_id 字段",
          "为失败场景提供可切换 mock，例如 ?mode=error 或 ?mode=empty",
          "记录最小审计事件，便于后续替换真实服务",
        ],
        acceptance_criteria: [
          `GET ${sandbox.api_base}/summary 返回 200 和结构化 mock 数据`,
          "empty/error 模式可稳定复现",
          "前端沙盒页面只依赖当前模块 API 即可运行",
          "Mock API 字段可直接迁移为真实 API 契约初稿",
        ],
        test_plan: sandbox.sandbox_tests,
        risks: ["Mock API 不应被误认为生产接口，需要在 UI 和响应中标明 sandbox"],
        sandbox,
      },
      {
        key: `MOD-${index + 1}3`,
        title: `模块「${epic}」沙盒验收脚本与回归清单`,
        body: `## 目标\n为「${epic}」建立生成代码后的沙盒验收标准，确保 AI 生成 Patch 可被快速检查、预览、回滚。\n\n## 验收重点\n${sandbox.manual_checks.map((item) => `- ${item}`).join("\n")}`,
        labels: ["ai-workflow", "module", "qa", "sandbox"],
        issue_type: "Task",
        priority: "P2",
        owner: "QA Engineer",
        estimate: "0.25-0.5 day",
        affected_files: ["server.js", "static/app.js", "static/styles.css"],
        implementation_steps: [
          "补齐模块级手动验收清单",
          "确认 UI Preview 可以打开并展示模块页面",
          "确认 Patch 应用前必须完成前端功能与视觉勾选",
          "把 sandbox_tests 写入生成代码提示上下文",
        ],
        acceptance_criteria: sandbox.manual_checks,
        test_plan: sandbox.sandbox_tests,
        risks: ["缺少浏览器自动化环境时，首版以手动验收为准"],
        sandbox,
      },
    ];
  });
};

const normalizeIssueCardBase = normalizeIssueCard;
normalizeIssueCard = function normalizeSandboxReadyIssueCard(issue, index = 0) {
  const card = normalizeIssueCardBase(issue, index);
  const sandbox = issue.sandbox || card.sandbox || sandboxContractFor(card.title, index);
  const labels = [...new Set([...(card.labels || []), ...(issue.sandbox ? ["sandbox"] : [])])];
  return {
    ...card,
    labels,
    sandbox,
    test_plan: card.test_plan?.length ? card.test_plan : sandbox.sandbox_tests,
    manual_checks: issue.manual_checks || card.manual_checks || sandbox.manual_checks,
    api_contract: issue.api_contract || card.api_contract || sandbox.api_contract,
    mock_data: issue.mock_data || card.mock_data || sandbox.mock_data,
  };
};

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

const AGENT_EMPLOYEE_ROLES = [
  {
    id: "requirements-analyst",
    title: "需求分析师",
    agent_name: "需求分析师 Agent",
    responsibility: "把客户原始想法、会议纪要和零散材料转成可确认、可拆解、可交付的需求基线。",
    deliverables: ["需求澄清文档", "业务目标地图", "用户角色与场景", "范围边界说明", "约束与风险清单", "待确认问题清单"],
    deliverable_details: [
      {
        title: "需求澄清文档",
        detail: "沉淀客户背景、业务目标、原始材料摘要、关键术语和已确认假设，作为产品、设计、架构继续工作的统一输入。",
      },
      {
        title: "业务目标地图",
        detail: "把客户目标拆成可衡量的业务结果，例如效率提升、风险降低、交付周期、合规留痕或客户体验指标。",
      },
      {
        title: "用户角色与场景",
        detail: "识别主要用户、协作角色、管理员和外部参与方，并描述各角色在核心流程中的任务、痛点和成功标准。",
      },
      {
        title: "范围边界说明",
        detail: "明确本期必须交付、可延后交付和暂不包含的内容，减少后续 PRD、排期和报价过程中的范围漂移。",
      },
      {
        title: "约束与风险清单",
        detail: "整理隐私、权限、审计、集成、性能、周期、预算和人工复核等约束，并标注对方案设计的影响。",
      },
      {
        title: "待确认问题清单",
        detail: "列出需要客户、业务负责人或技术负责人确认的问题，保证进入产品设计前没有关键空白。",
      },
    ],
    detail_sections: [
      {
        title: "输入信息",
        items: ["客户原始需求或会议纪要", "业务目标与成功口径", "目标用户与组织角色", "约束条件、偏好技术栈和交付周期"],
      },
      {
        title: "分析动作",
        items: ["归纳业务目标和场景", "识别角色、权限和核心流程", "抽取范围边界和集成依赖", "标注风险、假设和待确认问题"],
      },
      {
        title: "交付给下游",
        items: ["产品经理用于 PRD 和 Backlog 拆解", "UI 设计师用于页面场景和信息架构", "架构师用于系统边界、安全策略和集成设计"],
      },
    ],
    acceptance_criteria: [
      "业务目标能对应到可验证的结果或指标。",
      "每类目标用户都有清晰的使用场景和关键任务。",
      "范围内、范围外和后续版本内容能被客户确认。",
      "高风险约束和待确认问题不会被带入下游阶段而无人负责。",
    ],
    actions: [
      { id: "generate-requirement-analysis-report", label: "生成需求分析报告", description: "汇总业务目标、角色、范围、约束和初步风险，形成需求基线报告。" },
      { id: "generate-clarification-questions", label: "生成待确认问题", description: "抽取进入产品设计前必须确认的问题，便于客户和业务负责人补充。" },
      { id: "handoff-requirement-baseline", label: "确认需求基线并交接产品经理", description: "将需求分析师产物标记为已确认，并提示产品经理进入需求文档和原型阶段。" },
    ],
    stage_ids: ["business-requirement", "intake"],
  },
  {
    id: "product-manager",
    title: "产品经理",
    agent_name: "产品经理 Agent",
    responsibility: "承接需求分析师的需求基线，生成可评审的需求文档、页面清单、用户故事、验收标准和产品原型。",
    deliverables: ["需求文档", "产品原型", "页面清单", "用户故事", "Backlog", "验收标准"],
    deliverable_details: [
      {
        title: "需求文档",
        detail: "把需求分析师输出的业务目标、用户角色、范围边界和约束条件整理成可评审 PRD，明确本期范围、页面能力和验收口径。",
      },
      {
        title: "产品原型",
        detail: "基于需求文档生成可点击原型或业务原型图，展示页面结构、核心流程、关键状态和研发可交付范围。",
      },
      {
        title: "页面清单",
        detail: "列出本期需要交付的页面、页面目标、主操作、输入输出和页面之间的跳转关系。",
      },
      {
        title: "用户故事",
        detail: "按角色描述业务价值、使用场景和成功条件，为后续排期、测试和客户验收提供共同语言。",
      },
      {
        title: "Backlog",
        detail: "把页面和能力拆成可进入研发排期的任务草案，并保留优先级、负责人、估算和标签。",
      },
      {
        title: "验收标准",
        detail: "定义页面、流程、AI 输出、异常状态和人工确认点的验收条件，确保交付结果可验证。",
      },
    ],
    detail_sections: [
      {
        title: "上游输入",
        items: ["需求分析师的需求澄清文档", "业务目标地图", "用户角色与场景", "范围边界说明", "约束与风险清单"],
      },
      {
        title: "产品动作",
        items: ["提炼产品范围和 MVP", "拆解页面、流程和关键状态", "编写需求文档与用户故事", "生成产品原型用于客户评审"],
      },
      {
        title: "下游交付",
        items: ["交给架构师设计技术方案", "交给 UI 设计师细化视觉方案", "交给研发负责人拆解实施任务和沙盒验证"],
      },
    ],
    acceptance_criteria: [
      "需求文档能追溯到需求分析师的业务目标和范围边界。",
      "产品原型覆盖主要页面、核心流程、关键状态和人工确认点。",
      "页面清单能直接驱动 Backlog、UI 设计和研发实施方案。",
      "每个用户故事都有明确角色、价值和验收条件。",
    ],
    actions: [
      { id: "generate-product-prototype", label: "生成产品原型", description: "根据当前需求文档生成可点击原型预览。" },
      { id: "handoff-product-baseline", label: "确认产品产物并交接 UI 设计师", description: "确认需求文档、页面清单和产品原型，解锁 UI 设计师岗位。" },
    ],
    stage_ids: ["requirement-doc", "product", "business-prototype"],
  },
  {
    id: "ui-designer",
    title: "UI设计师",
    agent_name: "UI 设计师 Agent",
    responsibility: "承接产品经理的需求文档和产品原型，生成设计系统、业务 UI 图、视觉效果图、交互状态和响应式规则。",
    deliverables: ["设计系统", "UI 效果图", "页面视觉方案", "交互状态", "响应式规则"],
    deliverable_details: [
      {
        title: "设计系统",
        detail: "定义颜色、字体、间距、按钮、表单、表格、状态标签和反馈组件，保证后续页面实施保持一致。",
      },
      {
        title: "业务 UI 图",
        detail: "把产品原型转成面向客户评审的业务设计图，突出真实页面结构、主操作、关键数据和状态反馈。",
      },
      {
        title: "UI 效果图",
        detail: "生成可打开的视觉效果图预览，用于确认整体风格、布局密度、组件组合和页面视觉质量。",
      },
      {
        title: "交互状态",
        detail: "补齐加载、空态、错误、成功、提交中、需人工确认等状态，避免开发阶段遗漏边界体验。",
      },
      {
        title: "响应式规则",
        detail: "明确桌面、平板、移动端布局变化、信息优先级和文字不溢出的约束。",
      },
    ],
    detail_sections: [
      {
        title: "上游输入",
        items: ["产品经理的需求文档", "产品原型", "页面清单", "用户故事和验收标准"],
      },
      {
        title: "设计动作",
        items: ["选择适合业务系统的视觉风格", "生成设计系统和页面设计图", "补齐状态、响应式和可访问性规则", "为开发人员提供可实施的视觉依据"],
      },
      {
        title: "下游交付",
        items: ["交给开发人员拆解页面实施方案", "交给测试人员检查视觉和交互验收点", "交给交付经理用于客户评审材料"],
      },
    ],
    acceptance_criteria: [
      "UI 图能追溯到产品原型和需求文档。",
      "页面主操作、关键数据、状态反馈和异常入口清晰可见。",
      "设计系统包含颜色、字号、间距、组件和交互状态规则。",
      "桌面和移动端布局无重叠、无文字溢出。",
      "确认后的设计稿可以交给开发人员生成实施方案。",
    ],
    actions: [
      { id: "generate-business-ui", label: "生成业务 UI 图", description: "根据需求文档、产品原型和页面任务生成业务设计图。" },
      { id: "generate-ui-designer-concept", label: "生成 UI 视觉设计方案", description: "生成设计系统、视觉方案、设计理由和效果图预览。" },
      { id: "handoff-ui-design", label: "确认设计稿并交接开发人员", description: "将 UI 设计师产物标记为已确认，并切换到开发人员岗位。" },
    ],
    stage_ids: ["business-ui"],
  },
  {
    id: "architect",
    title: "架构师",
    agent_name: "架构师 Agent",
    responsibility: "设计系统架构、接口契约、数据模型、部署边界和安全策略。",
    deliverables: ["架构文档", "API 契约", "数据模型", "技术选型", "安全方案"],
    actions: [{ id: "confirm-current-role", label: "确认架构方案并交接开发人员", description: "确认架构产物后，解锁开发人员岗位。" }],
    stage_ids: ["architecture-doc", "architecture", "parameter-doc"],
  },
  {
    id: "developer",
    title: "开发人员",
    agent_name: "开发人员 Agent",
    responsibility: "把页面方案拆成实现任务、Patch 草案、Mock API 和可沙盒测试的代码路径。",
    deliverables: ["实施方案", "Patch 草案", "Mock API", "代码生成计划", "沙盒入口"],
    actions: [{ id: "confirm-current-role", label: "确认开发产物并交接测试人员", description: "确认实施方案、Patch 和沙盒入口后，解锁测试人员岗位。" }],
    stage_ids: ["page-implementation", "delivery"],
  },
  {
    id: "tester",
    title: "测试人员",
    agent_name: "测试人员 Agent",
    responsibility: "生成测试计划、验收清单、质量门禁、回归策略和缺陷风险。",
    deliverables: ["测试计划", "验收清单", "质量报告", "回归清单", "风险说明"],
    actions: [{ id: "confirm-current-role", label: "确认测试产物并完成流程", description: "确认测试与验收产物，完成本轮交付流程。" }],
    stage_ids: ["quality", "page-implementation"],
  },
];

function buildAgentEmployees(workflow = {}) {
  const stages = workflow.stages || [];
  return AGENT_EMPLOYEE_ROLES.map((role, index) => {
    const ownedStages = stages.filter((item) => role.stage_ids.includes(item.id));
    const primaryStage = ownedStages[0] || null;
    const artifacts = ownedStages.flatMap((item) =>
      (item.artifacts || []).map((artifactItem) => ({
        stage_id: item.id,
        stage_name: item.name,
        title: artifactItem.title,
        kind: artifactItem.kind || "markdown",
        content: artifactItem.content || "",
      }))
    );
    return {
      ...role,
      order: index + 1,
      status: primaryStage ? "completed" : "pending",
      current_task: primaryStage?.summary || role.responsibility,
      outputs: artifacts.length ? artifacts : role.deliverables.map((title) => ({ title, kind: "planned" })),
      stage_ids: role.stage_ids,
    };
  });
}

function attachAgentEmployees(workflow = {}) {
  return {
    ...workflow,
    agent_employees: buildAgentEmployees(workflow),
  };
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

function inferBusinessPages(request = {}, signals = null) {
  const text = [
    request.project_name,
    request.goal,
    request.source_material,
    request.constraints,
    request.target_users,
  ].filter(Boolean).join(" ").toLowerCase();
  const pages = [
    { id: "requirements-home", name: "业务需求首页", purpose: "录入业务目标、约束、用户角色和原始材料，是整个生成流程的起点。" },
    { id: "docs-review", name: "文档评审页", purpose: "查看并确认需求文档、参数文档和架构文档。" },
    { id: "prototype-board", name: "业务原型图页", purpose: "展示业务流程、页面关系和关键操作路径。" },
    { id: "ui-board", name: "业务 UI 图页", purpose: "展示面向客户评审的业务设计稿和页面视觉布局。" },
    { id: "implementation-plan", name: "页面实施方案页", purpose: "按页面拆解实现步骤、文件范围、接口契约和验收标准。" },
    { id: "patch-review", name: "Patch 草案审查页", purpose: "查看代码差异草案、风险说明、测试命令和回滚方案。" },
    { id: "code-generation", name: "代码生成页", purpose: "根据实施方案和 Patch 草案生成代码改动。" },
    { id: "sandbox-test", name: "沙盒测试页", purpose: "在 Mock API 和隔离预览环境中验证页面和业务流程。" },
  ];
  if (text.includes("审批") || text.includes("approval")) {
    pages.splice(4, 0, { id: "approval-flow", name: "业务审批页", purpose: "处理提交、退回、通过、审批意见和版本锁定。" });
  }
  if (text.includes("报告") || text.includes("pdf") || text.includes("导出")) {
    pages.splice(5, 0, { id: "report-export", name: "报告导出页", purpose: "预览业务报告、确认版本并导出交付材料。" });
  }
  if (text.includes("看板") || text.includes("dashboard")) {
    pages.splice(2, 0, { id: "business-dashboard", name: "业务看板页", purpose: "展示关键指标、待办事项、风险分布和交付进度。" });
  }
  return pages.slice(0, 10);
}

function pageSandboxContract(page, index) {
  const slug = slugifyModuleName(page.id || page.name, `page-${index + 1}`);
  const route = `/sandbox/pages/${slug}`;
  const apiBase = `/api/sandbox/pages/${slug}`;
  return {
    slug,
    route,
    api_base: apiBase,
    mock_data_id: `${slug}-mock-001`,
    mock_data: {
      id: `${slug}-mock-001`,
      page_name: page.name,
      status: "ready_for_review",
      primary_action: "确认并进入下一步",
      secondary_action: "返回修改",
      records: [
        { id: "item-1", title: "示例业务记录", status: "待确认" },
        { id: "item-2", title: "示例生成结果", status: "已生成" },
      ],
    },
    api_contract: [
      `GET ${apiBase}/state -> 返回页面 mock 状态、表单默认值和列表数据`,
      `POST ${apiBase}/actions/primary -> 模拟页面主操作并返回下一状态`,
      `POST ${apiBase}/actions/reset -> 重置当前页面 mock 数据`,
    ],
    sandbox_tests: [
      "node --check server.js",
      "node --check static/app.js",
      `手动打开 ${route}`,
      `调用 GET ${apiBase}/state，确认返回当前页面 mock 数据`,
    ],
    manual_checks: [
      "页面可在无数据库、无外部 API 的情况下独立演示",
      "加载态、空状态、错误态、成功态都有明确反馈",
      "主操作只影响当前页面 mock 数据",
      "页面文案与业务需求、参数文档和架构文档保持一致",
    ],
  };
}

function buildPageIssueDrafts(pages) {
  return pages.map((page, index) => {
    const sandbox = pageSandboxContract(page, index);
    return {
      key: `PAGE-${String(index + 1).padStart(2, "0")}`,
      title: `页面「${page.name}」实施方案、Patch、代码生成与沙盒测试`,
      body: `## 页面目标\n${page.purpose}\n\n## 页面级交付链路\n1. 生成实施方案\n2. 生成 Patch 草案\n3. 生成功能代码\n4. 进入沙盒测试\n5. 通过后再应用到主工作区\n\n## 沙盒入口\n- 页面：${sandbox.route}\n- Mock API：${sandbox.api_base}`,
      labels: ["ai-workflow", "page", "sandbox", "codegen"],
      issue_type: "Task",
      priority: index <= 2 ? "P1" : "P2",
      owner: index <= 3 ? "Frontend Engineer" : "Full-stack Engineer",
      estimate: "0.5-1 day",
      affected_files: ["static/index.html", "static/app.js", "static/styles.css", "server.js"],
      implementation_steps: [
        `为「${page.name}」建立 ${sandbox.route} 沙盒入口`,
        "按页面状态拆分 loading、ready、empty、error、submitting",
        "接入 mock API 契约，不依赖真实数据库和外部服务",
        "补齐 UI 图对应的信息层级、主操作和反馈状态",
        "生成 Patch 草案后先走 UI 预览和沙盒测试，再应用代码",
      ],
      acceptance_criteria: [
        `${sandbox.route} 可独立访问并展示该页面的业务 UI`,
        "页面主操作能通过 mock 数据完成闭环",
        "实施方案、Patch 草案、生成代码和沙盒测试链路清晰可追踪",
        "桌面和移动端布局无重叠、无文字溢出",
      ],
      test_plan: sandbox.sandbox_tests,
      manual_checks: sandbox.manual_checks,
      sandbox,
      mock_data: sandbox.mock_data,
      api_contract: sandbox.api_contract,
    };
  });
}

runDeterministicWorkflow = function runBusinessDesignWorkflow(request) {
  request = cleanWorkflowInput(request);
  const signals = extractSignals(request);
  const pages = inferBusinessPages(request, signals);
  const issueDrafts = buildPageIssueDrafts(pages);
  const pageList = pages.map((page, index) => `${index + 1}. ${page.name}：${page.purpose}`).join("\n");

  const stages = [
    stage("business-requirement", "1. 首页业务需求", "业务分析 Agent", "收集业务目标、目标用户、约束条件和原始材料，作为后续文档与设计图生成的唯一入口。", [
      artifact("首页业务需求", `
## 业务目标
${request.goal}

## 客户与行业
- 客户：${request.client_name || "待确认客户"}
- 行业：${request.industry || "待确认行业"}
- 目标用户：${request.target_users || "待确认用户"}

## 原始材料
${request.source_material}

## 约束条件
${request.constraints}
`),
    ]),
    stage("requirement-doc", "2. 生成需求文档", "产品经理 Agent", "把业务需求转成可评审的需求文档，明确范围、角色、流程和验收口径。", [
      artifact("需求文档", `
## 产品目标
${request.goal}

## 核心业务模块
${bullets(signals.epics)}

## 页面清单
${pageList}

## 用户故事
${bullets(signals.stories)}

## 验收原则
- 每个页面必须有独立沙盒入口。
- 每个页面必须有 Mock API 和 mock 数据。
- 每个页面必须可以先预览、再生成 Patch、再生成代码、最后沙盒测试。
`),
    ]),
    stage("parameter-doc", "3. 生成参数文档", "参数建模 Agent", "定义页面参数、Mock API、状态机、输入输出和沙盒测试数据。", [
      artifact("参数文档", `
## 页面参数模型
${pages.map((page, index) => {
  const sandbox = pageSandboxContract(page, index);
  return `### ${page.name}
- route: ${sandbox.route}
- api_base: ${sandbox.api_base}
- mock_data_id: ${sandbox.mock_data_id}
- primary_action: ${sandbox.mock_data.primary_action}`;
}).join("\n\n")}

## 通用状态
- loading
- ready
- empty
- error
- submitting
- success
`),
    ]),
    stage("architecture-doc", "4. 生成架构文档", "架构师 Agent", "定义从业务需求到文档、原型图、UI 图、页面级代码生成和沙盒测试的架构。", [
      artifact("架构文档", `
## 流程架构
\`\`\`text
首页业务需求
  -> 需求文档 / 参数文档 / 架构文档
  -> 业务原型图
  -> 业务 UI 图
  -> 页面级实施方案
  -> 页面级 Patch 草案
  -> 代码生成
  -> 沙盒测试
\`\`\`

## 技术边界
- 前端：HTML/CSS/JavaScript 工作台与预览页面
- 后端：Node.js 本地服务、内存项目状态、Mock API
- 沙盒：/preview 与 /sandbox 路由隔离验证
- 代码生成：先生成草案，人工确认后应用

## 推荐技术栈
${request.tech_stack}
`),
    ]),
    stage("business-prototype", "5. 生成产品原型", "产品经理 Agent", "产品经理承接需求文档，生成业务流程、页面关系和核心操作路径，面向客户评审与研发拆解。", [
      artifact("业务原型图说明", `
## 原型画板
${pageList}

## 原型关注点
- 页面之间的业务流转
- 每个页面的输入、处理、输出
- 角色在流程中的责任边界
- 进入实施前必须确认的业务规则
`),
    ]),
    stage("business-ui", "6. 生成业务 UI 图", "UI 设计 Agent", "生成面向客户评审的业务设计图，突出信息层级、业务操作和状态反馈。", [
      artifact("业务 UI 图说明", `
## UI 设计画板
${pages.map((page) => `- ${page.name}：${page.purpose}`).join("\n")}

## UI 关注点
- 业务信息优先，不做营销式页面。
- 每张图必须体现主操作、关键数据、状态反馈和异常入口。
- UI 图用于客户评审与页面级实施方案拆分。
`),
    ]),
    stage("page-implementation", "7. 按页面生成实施方案 / Patch / 代码 / 沙盒测试", "研发负责人 Agent", "把每个业务页面拆成可生成代码和可沙盒测试的任务卡。", [
      artifact("页面级实施任务", issueDrafts.map((issue) => `- ${issue.key}：${issue.title}（${issue.sandbox.route}）`).join("\n")),
    ]),
  ];

  return {
    workflow_id: crypto.randomBytes(5).toString("hex"),
    created_at: new Date().toISOString(),
    project_name: request.project_name,
    client_name: request.client_name || "",
    stages,
    metrics: {
      estimated_sprints: Math.max(2, Math.min(6, Math.ceil(pages.length / 2))),
      epics: signals.epics.length,
      stories: issueDrafts.length,
      risks: signals.risks.length,
      integrations: signals.integrations.length,
    },
    backlog_issues: issueDrafts.map(normalizeIssueCard),
    generation_mode: "deterministic",
    next_actions: [
      "先确认首页业务需求字段是否完整。",
      "评审需求文档、参数文档和架构文档。",
      "生成并评审业务原型图和业务 UI 图。",
      "按页面逐个生成实施方案、Patch 草案、代码并进入沙盒测试。",
    ],
  };
};

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

const ROLE_STAGE_DEFINITIONS = [
  {
    roleId: "requirements-analyst",
    id: "business-requirement",
    name: "1. 需求分析师生成需求基线",
    owner: "需求分析师 Agent",
    artifactTitle: "需求分析报告",
    mission: "分析客户原始需求，输出需求澄清、业务目标、用户角色、范围边界、约束风险和待确认问题。",
  },
  {
    roleId: "product-manager",
    id: "requirement-doc",
    name: "2. 产品经理生成需求文档与产品原型",
    owner: "产品经理 Agent",
    artifactTitle: "需求文档与产品原型说明",
    mission: "承接需求分析师产物，输出 PRD、页面清单、用户故事、验收标准和产品原型说明。",
  },
  {
    roleId: "ui-designer",
    id: "business-ui",
    name: "3. UI 设计师生成业务 UI 图",
    owner: "UI 设计师 Agent",
    artifactTitle: "UI 设计方案",
    mission: "承接产品文档和原型，输出设计系统、业务 UI 图、视觉方案、交互状态和响应式规则。",
  },
  {
    roleId: "architect",
    id: "architecture-doc",
    name: "4. 架构师生成架构文档",
    owner: "架构师 Agent",
    artifactTitle: "架构文档",
    mission: "承接需求、产品和 UI 产物，输出技术架构、接口契约、数据模型、部署边界和安全策略。",
  },
  {
    roleId: "developer",
    id: "page-implementation",
    name: "5. 开发人员生成实施任务",
    owner: "开发人员 Agent",
    artifactTitle: "实施方案与任务拆解",
    mission: "承接架构和设计产物，输出页面实施方案、Mock API、代码生成计划、沙盒入口和结构化 Backlog。",
    includeBacklog: true,
  },
  {
    roleId: "tester",
    id: "quality",
    name: "6. 测试人员生成测试验收方案",
    owner: "测试人员 Agent",
    artifactTitle: "测试验收方案",
    mission: "承接开发任务，输出测试计划、验收清单、质量门禁、回归策略和风险说明。",
  },
];

async function callOpenAIJson(prompt) {
  const maxAttempts = Number(process.env.OPENAI_MAX_RETRIES || 3);
  const requestTimeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 600000);
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

function compactWorkflowContext(workflow = {}) {
  return {
    project_name: workflow.project_name || "",
    client_name: workflow.client_name || "",
    metrics: workflow.metrics || {},
    stages: (workflow.stages || []).map((stageItem) => ({
      id: stageItem.id,
      name: stageItem.name,
      owner: stageItem.owner,
      summary: stageItem.summary,
      artifacts: (stageItem.artifacts || []).map((item) => ({
        title: item.title,
        content: String(item.content || "").slice(0, 4000),
      })),
    })),
    backlog_issues: (workflow.backlog_issues || []).slice(0, 12).map((issue) => ({
      key: issue.key,
      title: issue.title,
      labels: issue.labels,
      priority: issue.priority,
      owner: issue.owner,
      sandbox: issue.sandbox,
    })),
    request: workflow.request || {},
  };
}

async function runRoleLlmAgent({ roleId, roleName, actionName, workflow, extra = {}, fallback = {} }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("未启用 LLM：请通过 CC Switch 或 OPENAI_API_KEY 配置模型后再执行岗位 Agent。");
  }

  const prompt = `
你是软件开发公司 AI 工作流中的「${roleName}」。
当前岗位动作：${actionName}

请基于工作流上下文生成专业、可交付、可给下游岗位使用的结构化结果。
必须只返回 JSON，不要返回 Markdown 代码块。

返回 JSON 结构：
{
  "title": "产物标题",
  "summary": "一句话总结",
  "items": ["关键结论或待办"],
  "artifact_markdown": "Markdown 格式详细产物",
  "screens": ["如果适用，页面或画板名称"],
  "design_system": {"tokens": {}, "components": []},
  "rationale": ["设计或决策理由"]
}

工作流上下文：
${JSON.stringify(compactWorkflowContext(workflow), null, 2)}

额外输入：
${JSON.stringify(extra, null, 2)}
`;

  const result = await callOpenAIJson(prompt);
  return {
    ...fallback,
    ...result,
    generation_mode: "llm_agent",
    role_id: roleId,
    role_name: roleName,
    action_name: actionName,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    generated_at: new Date().toISOString(),
  };
}

async function callOpenAIJson(prompt) {
  const maxAttempts = Number(process.env.OPENAI_MAX_RETRIES || 3);
  const requestTimeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 600000);
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

      try {
        return await requestJson(
          openAIChatCompletionsUrl(),
          {
            model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          },
          "OpenAI Chat"
        );
      } catch (chatError) {
        const combined = new Error(`OpenAI Responses failed, Chat fallback also failed. Responses: ${lastError?.message || "unknown"} | Chat: ${chatError.message}`);
        combined.status = chatError.status || lastError?.status;
        throw combined;
      }
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

async function runRoleStageAgent(roleStage, workflow, extra = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("未启用 LLM：请通过 CC Switch 或 OPENAI_API_KEY 配置模型后再生成角色产物。");
  }
  const prompt = `
你是软件开发公司 AI 工作流中的「${roleStage.owner}」。

当前阶段：${roleStage.name}
当前任务：${roleStage.mission}

请只输出 JSON，不要输出 Markdown 代码围栏。
JSON 字段必须包含：
{
  "summary": "一句话阶段摘要",
  "artifact_content": "Markdown 格式阶段产物"
}

${roleStage.includeBacklog ? `如果你是开发人员 Agent，还必须输出：
{
  "backlog_issues": [
    {
      "key": "PAGE-01",
      "title": "页面或模块实施任务标题",
      "body": "Markdown，包含背景、实施要点、验收标准",
      "labels": ["ai-workflow"],
      "issue_type": "Task",
      "priority": "P1",
      "owner": "Frontend Engineer",
      "estimate": "0.5-1 day",
      "affected_files": ["server.js", "static/app.js"],
      "implementation_steps": ["实现页面结构", "接入 Mock API"],
      "acceptance_criteria": ["可沙盒验证"],
      "test_plan": ["node --check server.js", "node --check static/app.js"]
    }
  ]
}
要求 backlog_issues 生成 6 到 14 条。` : ""}

约束：
- 所有内容使用简体中文。
- 只能基于已经确认的上游阶段继续生成，不要跳过确认流程。
- 内容必须可交付、可审查、可交给下游岗位继续使用。

当前工作流：
${JSON.stringify(compactWorkflowContext(workflow), null, 2)}

额外输入：
${JSON.stringify(extra, null, 2)}
`;
  const parsed = await callOpenAIJson(prompt);
  return {
    parsed,
    stage: stage(
      roleStage.id,
      roleStage.name,
      roleStage.owner,
      parsed.summary || `${roleStage.owner} 已生成阶段产物。`,
      [artifact(roleStage.artifactTitle, parsed.artifact_content || parsed.artifact_markdown || "")]
    ),
  };
}

async function generateNextRoleStage(workflow, roleId, extra = {}) {
  const roleStage = ROLE_STAGE_DEFINITIONS.find((item) => item.roleId === roleId);
  if (!roleStage) throw new Error(`未知角色：${roleId}`);
  updateWorkflowStatus({
    running: true,
    current_agent: roleStage.owner,
    error: "",
    workflow_id: workflow.workflow_id,
  });
  const result = await runRoleStageAgent(roleStage, workflow, extra);
  const existingStages = (workflow.stages || []).filter((item) => item.id !== roleStage.id);
  workflow.stages = [...existingStages, result.stage];
  if (roleStage.includeBacklog && Array.isArray(result.parsed.backlog_issues) && result.parsed.backlog_issues.length) {
    workflow.backlog_issues = result.parsed.backlog_issues.map(normalizeIssueCard);
    workflow.metrics = {
      ...(workflow.metrics || {}),
      stories: workflow.backlog_issues.length,
    };
  }
  workflow.generation_mode = "role_sequential_llm";
  workflow.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  workflow.agent_employees = buildAgentEmployees(workflow);
  updateWorkflowStatus({
    running: false,
    current_agent: "完成",
    completed_agents: [...new Set([...(workflowStatus.completed_agents || []), roleStage.owner])],
    finished_at: new Date().toISOString(),
    error: "",
    workflow_id: workflow.workflow_id,
  });
  return { workflow, stage: result.stage, parsed: result.parsed };
}

async function generateWithOpenAI(request, fallbackWorkflow) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("未启用 LLM：请通过 CC Switch 或 OPENAI_API_KEY 配置模型后再运行工作流。");
  }

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

  return attachAgentEmployees({
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
  });
}

async function runWorkflow(request) {
  request = cleanWorkflowInput(request);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("未启用 LLM：请通过 CC Switch 或 OPENAI_API_KEY 配置模型后再运行工作流。");
  }
  const signals = extractSignals(request);
  const workflow = attachAgentEmployees({
    workflow_id: crypto.randomBytes(5).toString("hex"),
    created_at: new Date().toISOString(),
    project_name: request.project_name,
    client_name: request.client_name || "",
    request,
    stages: [],
    metrics: {
      estimated_sprints: Math.max(2, Math.min(6, signals.sprints || 3)),
      epics: signals.epics.length,
      stories: 0,
      risks: signals.risks.length,
      integrations: signals.integrations.length,
    },
    backlog_issues: [],
    generation_mode: "role_sequential_llm",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    next_actions: ["确认需求分析师产物后，再生成产品经理产物。"],
  });
  updateWorkflowStatus({
    running: true,
    current_agent: "需求分析师 Agent",
    completed_agents: [],
    started_at: new Date().toISOString(),
    finished_at: null,
    error: "",
    workflow_id: workflow.workflow_id,
  });
  try {
    const { workflow: result } = await generateNextRoleStage(workflow, "requirements-analyst", { initial_request: request });
    updateWorkflowStatus({
      running: false,
      current_agent: "完成",
      finished_at: new Date().toISOString(),
      error: "",
      workflow_id: result.workflow_id,
    });
    return result;
  } catch (error) {
    updateWorkflowStatus({
      running: false,
      current_agent: "LLM Agent 生成失败",
      finished_at: new Date().toISOString(),
      error: error.message,
      workflow_id: workflow.workflow_id,
    });
    throw error;
  }
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

async function runEmployeeRoleAction(workflow, body = {}) {
  if (!workflow) throw new Error("请先运行 AI 工作流，再执行岗位 Agent。");
  const roleMap = {
    "requirements-analyst": "需求分析师 Agent",
    "product-manager": "产品经理 Agent",
    "ui-designer": "UI 设计师 Agent",
    architect: "架构师 Agent",
    developer: "开发人员 Agent",
    tester: "测试人员 Agent",
  };
  const actionMap = {
    "generate-requirement-analysis-report": "生成需求分析报告",
    "generate-clarification-questions": "生成待确认问题",
    "generate-current-role": "生成当前岗位产物",
    "handoff-requirement-baseline": "确认需求基线并交接产品经理",
    "handoff-product-baseline": "确认产品产物并交接 UI 设计师",
    "handoff-ui-design": "确认设计稿并交接开发人员",
    "confirm-current-role": "确认当前岗位产物并交接下游",
  };
  const roleId = body.role_id || "";
  const actionId = body.action_id || "";
  const fallback = {
    title: actionMap[actionId] || "岗位 Agent 结果",
    summary: process.env.OPENAI_API_KEY ? "岗位 Agent 已生成结果。" : "当前未配置 OPENAI_API_KEY，已使用本地岗位流程结果。",
    items: ["请检查当前岗位产物并确认后再进入下游岗位。"],
    artifact_markdown: "",
    generated_at: new Date().toISOString(),
  };
  if (actionId === "generate-current-role") {
    const generated = await generateNextRoleStage(workflow, roleId, {
      ...(body.extra || {}),
    });
    return {
      ...fallback,
      summary: `${roleMap[roleId] || "当前岗位 Agent"} 已生成产物，请确认后再进入下游岗位。`,
      role_id: roleId,
      generated_role_id: roleId,
      next_role_id: roleId,
      workflow: generated.workflow,
      generated_stage: generated.stage,
    };
  }
  const result = await runRoleLlmAgent({
    roleId,
    roleName: roleMap[roleId] || "软件开发岗位 Agent",
    actionName: actionMap[actionId] || actionId || "岗位动作",
    workflow,
    extra: body.extra || {},
    fallback,
  });
  const nextRoleByAction = {
  };
  const nextRoleId = nextRoleByAction[actionId];
  if (nextRoleId) {
    const generated = await generateNextRoleStage(workflow, nextRoleId, {
      previous_role_id: roleId,
      previous_action_id: actionId,
      role_agent_result: result,
      ...(body.extra || {}),
    });
    return {
      ...result,
      next_role_id: nextRoleId,
      workflow: generated.workflow,
      generated_stage: generated.stage,
    };
  }
  return result;
}

function findIssueCard(workflow, issueKey) {
  if (!workflow) throw new Error("还没有生成工作流，请先运行 AI 工作流。");
  const issues = (workflow.backlog_issues || []).map(normalizeIssueCard);
  const issue = issues.find((item) => item.key === issueKey);
  if (!issue) throw new Error(`未找到任务卡：${issueKey}`);
  return issue;
}

function generateLocalImplementationPlan(workflow, issue) {
  const sandbox = issue.sandbox || {};
  const files = issue.affected_files?.length ? issue.affected_files : ["server.js", "static/index.html", "static/app.js", "static/styles.css"];
  return {
    issue_key: issue.key,
    title: issue.title,
    summary: `规则引擎已为「${issue.title}」生成本地实施方案，可先用于人工评审、Patch 草案和沙盒验证。`,
    change_plan: files.map((file) => ({
      file,
      reason: file === "server.js" ? "补齐沙盒路由、Mock API、生成接口或页面状态数据。" : "补齐业务页面结构、交互状态、视觉样式和验证入口。",
      changes: [
        "围绕当前任务卡目标做最小可验证改动",
        "优先使用 mock_data 和 sandbox.api_base，不依赖真实数据库或外部服务",
        "保留人工确认与回滚入口",
      ],
    })),
    steps: [
      `确认任务卡范围：${issue.title}`,
      sandbox.route ? `建立或验证沙盒页面入口：${sandbox.route}` : "确认该页面或模块的沙盒入口",
      sandbox.api_base ? `建立或验证 Mock API：${sandbox.api_base}` : "确认 Mock API 与页面状态契约",
      "实现 loading、ready、empty、error、submitting、success 状态",
      "生成 Patch 草案后先做 UI 预览和沙盒测试，再应用到本地工作区",
    ],
    test_commands: issue.test_plan?.length ? issue.test_plan : [
      "node --check server.js",
      "node --check static/app.js",
      sandbox.route ? `手动打开 ${sandbox.route}` : "手动打开相关页面进行沙盒验证",
    ],
    acceptance_checks: issue.acceptance_criteria?.length ? issue.acceptance_criteria : [
      "页面可在无真实外部服务的情况下独立演示",
      "主操作可以通过 mock 数据完成闭环",
      "桌面端和移动端无明显重叠、溢出和乱码",
    ],
    risks: [
      "当前未配置 OPENAI_API_KEY，方案由本地规则引擎生成，不包含真实 Agent 的代码上下文推理。",
      "涉及文件可能需要开发者根据真实代码路径再次确认。",
    ],
    rollback_plan: [
      "不直接应用 Patch 草案，先通过 UI 预览和沙盒测试确认。",
      "如已应用，可使用生成的反向 Patch 或 git diff 定位并回退相关文件。",
    ],
    generated_at: new Date().toISOString(),
    model: "local-rule-engine",
    generation_mode: "fallback",
  };
}

function generateLocalPatchDraft(workflow, issue, implementationPlan = null) {
  const sandbox = issue.sandbox || {};
  return {
    issue_key: issue.key,
    title: issue.title,
    summary: `规则引擎已生成「${issue.title}」的 Patch 草案说明。未启用真实 Agent 时不自动伪造代码 diff，请按实施方案确认后再生成或手写 Patch。`,
    files: [],
    test_commands: implementationPlan?.test_commands || issue.test_plan || [
      "node --check server.js",
      "node --check static/app.js",
      sandbox.route ? `手动打开 ${sandbox.route}` : "手动打开相关沙盒页面",
    ],
    manual_checks: issue.manual_checks || [
      "确认页面内容与当前业务需求一致",
      "确认 Mock API 和沙盒页面可以独立演示",
      "确认前端功能和视觉效果后再应用真实代码改动",
    ],
    assumptions: [
      "当前环境未配置 OPENAI_API_KEY，因此没有调用真实代码 Agent。",
      "本地规则引擎只输出可评审草案，不伪造未知代码上下文的 diff。",
    ],
    risks: [
      "没有真实 Agent 时，Patch 需要开发者或后续代码 Agent 基于真实文件内容生成。",
      "如果直接进入应用 Patch，会因为没有 diff 文件而被阻止，这是预期保护。",
    ],
    rollback_plan: implementationPlan?.rollback_plan || [
      "Patch 未应用前无需回滚。",
      "如后续手动应用代码，使用 git diff 审查并按文件回退。",
    ],
    patch_quality: {
      valid: false,
      file_reports: [],
      reason: "local-rule-engine 未生成 unified diff",
    },
    generated_at: new Date().toISOString(),
    model: "local-rule-engine",
    status: "plan_only",
    generation_mode: "fallback",
  };
}

function localPatchLines(lines) {
  return lines.map((line) => `+${String(line).replace(/\r/g, "")}`).join("\n");
}

function localPatchMarkdown(workflow = {}, issue = {}, implementationPlan = null) {
  const sandbox = issue.sandbox || {};
  const plan = implementationPlan || {};
  const list = (items = []) => (items.length ? items.map((item) => `- ${item}`) : ["- 待补充"]);
  return [
    `# ${issue.key || "PAGE"} ${issue.title || "页面实施任务"}`,
    "",
    "## 项目信息",
    `- 项目：${workflow.project_name || "未命名项目"}`,
    `- 客户：${workflow.client_name || "未填写客户"}`,
    `- 生成模式：local-rule-engine`,
    "",
    "## 页面目标",
    issue.sandbox?.mock_data?.primary_action || issue.body?.split(/\r?\n/).find((line) => line && !line.startsWith("#")) || issue.title || "按当前业务需求完成页面级交付。",
    "",
    "## 沙盒入口",
    `- 页面：${sandbox.route || "待生成"}`,
    `- Mock API：${sandbox.api_base || "待生成"}`,
    `- Mock 数据：${sandbox.mock_data_id || "待生成"}`,
    "",
    "## 建议涉及文件",
    ...list(issue.affected_files || plan.change_plan?.map((item) => item.file).filter(Boolean) || []),
    "",
    "## 实施步骤",
    ...list(plan.steps || issue.implementation_steps || []),
    "",
    "## 测试命令",
    ...list(plan.test_commands || issue.test_plan || ["node --check server.js", "node --check static/app.js"]),
    "",
    "## 人工验收",
    ...list(issue.manual_checks || plan.acceptance_checks || issue.acceptance_criteria || []),
    "",
    "## 风险与回滚",
    ...list(plan.risks || ["本地规则引擎生成的是最小可应用 Patch，真实代码实现仍需结合代码上下文确认。"]),
    ...list(plan.rollback_plan || ["应用前先预览 diff；如不符合预期，使用撤销 Patch 或 git diff 回退。"]),
    "",
  ];
}

function buildAddFilePatch(filePath, lines) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    localPatchLines(lines),
    "",
  ].join("\n");
}

generateLocalPatchDraft = function generateApplicableLocalPatchDraft(workflow, issue, implementationPlan = null) {
  const sandbox = issue.sandbox || {};
  const slug = slugifyModuleName(issue.key || issue.title || "page-task", "page-task");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const filePath = `generated/page-plans/${slug}-${stamp}.md`;
  const markdownLines = localPatchMarkdown(workflow, issue, implementationPlan);
  const patch = buildAddFilePatch(filePath, markdownLines);
  const patchDraft = {
    issue_key: issue.key,
    title: issue.title,
    summary: `本地规则引擎已生成可应用 Patch：新增「${issue.title}」页面实施说明文件，作为后续代码生成和沙盒测试的落地依据。`,
    files: [
      {
        path: filePath,
        purpose: "新增页面级实施说明，记录业务目标、沙盒入口、Mock API、实施步骤和验收项。",
        patch,
      },
    ],
    test_commands: implementationPlan?.test_commands || issue.test_plan || [
      "node --check server.js",
      "node --check static/app.js",
      sandbox.route ? `手动打开 ${sandbox.route}` : "手动打开相关沙盒页面",
    ],
    manual_checks: issue.manual_checks || [
      "确认新增说明文件与当前业务页面一致",
      "确认沙盒页面和 Mock API 路径可用于后续实现",
      "确认后续真实代码 Patch 以该说明文件为实施依据",
    ],
    assumptions: [
      "当前环境未配置 OPENAI_API_KEY，因此由本地规则引擎生成保守可应用 Patch。",
      "该 Patch 只新增文档型交付文件，不直接修改运行时代码。",
    ],
    risks: [
      "该 Patch 不是完整功能代码实现，只是页面级实施落地说明。",
      "完整页面代码仍需真实 Agent 或开发者基于代码上下文继续生成。",
    ],
    rollback_plan: implementationPlan?.rollback_plan || [
      `删除 ${filePath}`,
      "或使用系统的撤销 Patch 功能反向应用该 diff。",
    ],
    generated_at: new Date().toISOString(),
    model: "local-rule-engine",
    status: "draft_only",
    generation_mode: "fallback",
  };
  return {
    ...patchDraft,
    patch_quality: patchQualityReport(patchDraft),
  };
};

async function generateImplementationPlan(workflow, issueKey) {
  const issue = findIssueCard(workflow, issueKey);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("未启用 LLM：无法生成实施方案。");
  }
  const prompt = `
你是资深软件工程负责人。请基于下面的实施任务卡，生成一份“代码自动化实施方案”。

要求：
- 只输出 JSON，不要输出 Markdown 代码围栏。
- 不要声称已经修改代码。
- 方案必须适合交给代码 Agent 或开发者执行。
- 如果任务卡的涉及文件只是推测，请在 risks 中说明需要先确认真实代码路径。
- 如果任务卡包含 sandbox，请优先围绕 sandbox.route、sandbox.api_base、mock_data 和 sandbox_tests 设计可独立验收的实现方案。
- 每个方案必须说明如何在无真实外部服务、无真实数据库的情况下完成沙盒验证。

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
  const issue = findIssueCard(workflow, issueKey);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("未启用 LLM：无法生成 Patch 草案。");
  }
  const prompt = `
你是资深代码生成 Agent。请基于任务卡和实施方案，生成“patch 草案”。

重要边界：
- 只输出 JSON，不要输出 Markdown 代码围栏。
- 这是草案，不会自动应用；不要声称已经修改文件。
- diff 必须尽量使用 unified diff 风格。
- 如果缺少真实代码上下文，请生成保守 patch 草案，并在 assumptions/risks 中说明需要人工确认。
- 不要发明密钥、真实外部账号或不可验证的配置。
- 如果任务卡包含 sandbox，请优先生成可在 sandbox.route 独立预览、可通过 mock API 或内存 fixture 测试的最小代码。
- test_commands 和 manual_checks 必须包含沙盒页面、mock API、UI 预览或手动验收路径。

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

function inferPrototypeScreens(workflow = {}) {
  const text = [
    workflow.project_name,
    workflow.client_name,
    ...(workflow.stages || []).flatMap((stage) => [
      stage.name,
      stage.summary,
      ...(stage.artifacts || []).map((artifact) => artifact.content),
    ]),
    ...(workflow.backlog_issues || []).flatMap((issue) => [issue.title, issue.body, ...(issue.labels || [])]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const screens = [
    { id: "dashboard", name: "工作台首页", desc: "集中展示关键指标、待处理事项和最近活动。" },
    { id: "list", name: "业务列表", desc: "支持搜索、筛选、状态查看和批量操作。" },
    { id: "detail", name: "详情页", desc: "承载对象信息、处理记录、协作备注和下一步动作。" },
  ];
  const add = (id, name, desc, keys) => {
    if (screens.some((item) => item.id === id)) return;
    if (keys.some((key) => text.includes(key))) screens.push({ id, name, desc });
  };

  add("auth", "登录与权限", "提供账号登录、角色选择和权限提示。", ["登录", "login", "auth", "权限", "角色"]);
  add("upload", "文件上传", "支持文件拖拽、元数据录入、解析状态和失败重试。", ["上传", "file", "pdf", "文档", "合同"]);
  add("ai", "AI 分析页", "展示 AI 处理进度、推理结果、引用依据和人工确认入口。", ["ai", "agent", "rag", "问答", "风险", "智能"]);
  add("approval", "审批流程", "覆盖提交审批、退回、通过、意见留痕和版本锁定。", ["审批", "审核", "approval", "复核"]);
  add("report", "报告与导出", "展示报告预览、编辑、版本记录和 PDF/Markdown 导出。", ["报告", "导出", "pdf", "export"]);
  add("settings", "系统配置", "管理知识库、成员、集成配置和审计日志。", ["配置", "知识库", "审计", "jira", "github", "集成"]);
  return screens.slice(0, 8);
}

function buildPrototypeHtml(workflow = {}) {
  const projectName = workflow.project_name || "AI 交付项目";
  const clientName = workflow.client_name || "客户";
  const screens = inferPrototypeScreens(workflow);
  const issues = (workflow.backlog_issues || []).slice(0, 6).map(normalizeIssueCard);
  const metrics = workflow.metrics || {};
  const primaryScreen = screens[0] || { name: "工作台首页", desc: "核心业务入口" };
  const stageNames = (workflow.stages || []).map((stage) => stage.name).slice(0, 6);

  const screenNav = screens
    .map((screen, index) => `<button class="${index === 0 ? "active" : ""}" data-screen="${screen.id}">${screen.name}</button>`)
    .join("");
  const screenSections = screens
    .map(
      (screen, index) => `
        <section class="screen ${index === 0 ? "active" : ""}" id="screen-${screen.id}">
          <div class="screen-title">
            <div>
              <p>${screen.name}</p>
              <h2>${screen.desc}</h2>
            </div>
            <button>主要操作</button>
          </div>
          <div class="screen-grid">
            <div class="canvas-card wide">
              <div class="card-head"><strong>${screen.name}流程</strong><span>Prototype</span></div>
              <div class="flow-row">
                ${["输入", "处理", "确认", "交付"].map((item) => `<div><b>${item}</b><small>${screen.name}</small></div>`).join("")}
              </div>
            </div>
            <div class="canvas-card">
              <div class="card-head"><strong>关键状态</strong><span>State</span></div>
              <ul>
                <li>待处理</li>
                <li>处理中</li>
                <li>需人工确认</li>
                <li>已完成</li>
              </ul>
            </div>
            <div class="canvas-card">
              <div class="card-head"><strong>用户动作</strong><span>Action</span></div>
              <button>新增</button>
              <button class="ghost">查看详情</button>
              <button class="ghost">提交下一步</button>
            </div>
          </div>
        </section>
      `
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} - 产品原型</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7f4; color: #17201b; font-family: Inter, "Segoe UI", Arial, sans-serif; }
    .app { min-height: 100vh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
    aside { background: #10231f; color: white; padding: 22px; display: grid; align-content: start; gap: 22px; }
    .brand { display: flex; gap: 10px; align-items: center; }
    .mark { width: 38px; height: 38px; border-radius: 8px; display: grid; place-items: center; background: #15a08f; font-weight: 800; }
    h1, h2, p { margin: 0; }
    aside h1 { font-size: 18px; line-height: 1.2; }
    aside p { color: #a8c4bc; font-size: 13px; margin-top: 4px; }
    nav { display: grid; gap: 8px; }
    nav button { background: transparent; border: 1px solid rgba(255,255,255,.12); color: #d8e9e4; border-radius: 6px; padding: 10px; text-align: left; cursor: pointer; font: inherit; }
    nav button.active, nav button:hover { background: #1f4f48; border-color: #3fbfaf; color: white; }
    main { padding: 24px; display: grid; gap: 18px; }
    .topbar, .hero, .screen, .canvas-card { background: white; border: 1px solid #d7ddd4; border-radius: 8px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; }
    .search { width: min(420px, 48vw); border: 1px solid #d7ddd4; border-radius: 6px; padding: 10px 12px; color: #65706a; background: #fbfcfa; }
    .hero { padding: 22px; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; }
    .hero h2 { font-size: 30px; margin: 6px 0 10px; letter-spacing: 0; }
    .hero p, .muted { color: #65706a; line-height: 1.5; }
    .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .kpi { border: 1px solid #d7ddd4; border-radius: 6px; padding: 12px; background: #fbfcfa; }
    .kpi b { display: block; color: #0f766e; font-size: 24px; }
    .screen { display: none; padding: 18px; }
    .screen.active { display: grid; gap: 16px; }
    .screen-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .screen-title p { color: #0f766e; font-weight: 800; font-size: 13px; }
    .screen-title h2 { font-size: 22px; margin-top: 4px; }
    button, .button { border: 0; border-radius: 6px; background: #0f766e; color: white; padding: 10px 12px; font-weight: 750; cursor: pointer; }
    button.ghost { background: #eef7f5; color: #115e59; }
    .screen-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 12px; }
    .canvas-card { padding: 14px; display: grid; gap: 12px; }
    .canvas-card.wide { grid-column: 1 / -1; }
    .card-head { display: flex; justify-content: space-between; color: #65706a; font-size: 13px; }
    .card-head strong { color: #17201b; font-size: 15px; }
    .flow-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .flow-row div { background: #eef7f5; border: 1px solid #c8ded7; border-radius: 6px; padding: 12px; display: grid; gap: 4px; }
    .flow-row small, li { color: #65706a; }
    ul { margin: 0; padding-left: 18px; line-height: 1.8; }
    .tasks { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .task { border: 1px solid #d7ddd4; background: #fbfcfa; border-radius: 6px; padding: 12px; }
    .task small { color: #65706a; display: block; margin-top: 6px; }
    @media (max-width: 900px) { .app { grid-template-columns: 1fr; } aside { position: static; } .hero, .screen-grid { grid-template-columns: 1fr; } .search { width: 100%; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand"><span class="mark">AI</span><div><h1>${escapeHtml(projectName)}</h1><p>${escapeHtml(clientName)}</p></div></div>
      <nav>${screenNav}</nav>
    </aside>
    <main>
      <header class="topbar">
        <strong>产品原型演示</strong>
        <div class="search">搜索页面、任务或客户资料</div>
      </header>
      <section class="hero">
        <div>
          <p class="muted">根据项目需求、PRD、Backlog 和交付约束自动生成</p>
          <h2>${escapeHtml(projectName)} 产品原型</h2>
          <p>${escapeHtml(primaryScreen.desc)} 当前原型聚焦页面结构、核心流程、关键状态和研发可交付范围，可用于客户评审与前端任务拆分。</p>
        </div>
        <div class="kpis">
          <div class="kpi"><b>${escapeHtml(metrics.epics || stageNames.length || screens.length)}</b><span>业务模块</span></div>
          <div class="kpi"><b>${escapeHtml(metrics.stories || issues.length)}</b><span>用户故事</span></div>
          <div class="kpi"><b>${escapeHtml(metrics.estimated_sprints || 4)}</b><span>预计迭代</span></div>
          <div class="kpi"><b>${escapeHtml(screens.length)}</b><span>原型页面</span></div>
        </div>
      </section>
      ${screenSections}
      <section class="canvas-card">
        <div class="card-head"><strong>研发任务映射</strong><span>Backlog</span></div>
        <div class="tasks">
          ${issues.map((issue) => `<div class="task"><b>${escapeHtml(issue.title)}</b><small>${escapeHtml((issue.labels || []).join(", "))}</small></div>`).join("")}
        </div>
      </section>
    </main>
  </div>
  <script>
    const buttons = Array.from(document.querySelectorAll("nav button"));
    const screens = Array.from(document.querySelectorAll(".screen"));
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        buttons.forEach((item) => item.classList.remove("active"));
        screens.forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        document.getElementById("screen-" + button.dataset.screen)?.classList.add("active");
      });
    });
  </script>
</body>
</html>`;
}

async function generateProductPrototype(workflow) {
  if (!workflow) throw new Error("请先运行工作流，再生成产品原型。");
  const previewId = `prototype_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const previewDir = path.join(previewRoot, previewId);
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, "index.html"), buildPrototypeHtml(workflow), "utf8");
  const screens = inferPrototypeScreens(workflow).map((screen) => screen.name);
  const fallback = {
    prototype_id: previewId,
    preview_url: `/preview/${previewId}/`,
    title: `${workflow.project_name || "项目"} 产品原型`,
    summary: "已根据当前项目需求、工作流阶段产物和 Backlog 自动生成可点击产品原型。",
    screens,
    generated_at: new Date().toISOString(),
  };
  return runRoleLlmAgent({
    roleId: "product-manager",
    roleName: "产品经理 Agent",
    actionName: "生成产品原型",
    workflow,
    extra: { screens, preview_url: fallback.preview_url },
    fallback,
  });
}

function extractBusinessPageName(issue = {}, index = 0) {
  const title = String(issue.title || "");
  const quoted = title.match(/页面[「《](.*?)[」》]/);
  if (quoted?.[1]) return quoted[1].trim();
  const mockName = issue.sandbox?.mock_data?.page_name || issue.mock_data?.page_name;
  if (mockName) return String(mockName).trim();
  const fallback = title
    .replace(/^PAGE-\d+\s*/i, "")
    .replace(/实施方案|Patch|代码生成|沙盒测试|页面|、|，|,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return fallback || `业务页面 ${String(index + 1).padStart(2, "0")}`;
}

function getStageArtifactContent(workflow = {}, stageId = "") {
  const stageItem = (workflow.stages || []).find((stage) => stage.id === stageId);
  return (stageItem?.artifacts || [])
    .map((artifact) => artifact.content || artifact.title || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildBusinessPrototypePages(workflow = {}) {
  const pageIssues = (workflow.backlog_issues || [])
    .map(normalizeIssueCard)
    .filter((issue) => String(issue.key || "").startsWith("PAGE-"));

  if (pageIssues.length) {
    return pageIssues.slice(0, 10).map((issue, index) => ({
      id: issue.sandbox?.slug || slugifyModuleName(issue.key || `page-${index + 1}`, `page-${index + 1}`),
      name: extractBusinessPageName(issue, index),
      purpose: issue.sandbox?.mock_data?.primary_action || issue.body?.split(/\r?\n/).find(Boolean) || "承载当前业务流程中的页面级交付、确认与验证。",
      route: issue.sandbox?.route || `/sandbox/pages/${slugifyModuleName(issue.key || `page-${index + 1}`, `page-${index + 1}`)}`,
      apiBase: issue.sandbox?.api_base || "",
      checks: (issue.manual_checks || issue.sandbox?.manual_checks || []).slice(0, 3),
      labels: issue.labels || [],
    }));
  }

  return inferBusinessPages({
    project_name: workflow.project_name,
    goal: workflow.request?.goal || workflow.goal,
    source_material: workflow.request?.source_material || workflow.source_material,
    constraints: workflow.request?.constraints || workflow.constraints,
    target_users: workflow.request?.target_users || workflow.target_users,
  }).map((page, index) => ({
    id: page.id || `page-${index + 1}`,
    name: page.name,
    purpose: page.purpose,
    route: `/sandbox/pages/${slugifyModuleName(page.id || page.name, `page-${index + 1}`)}`,
    apiBase: `/api/sandbox/pages/${slugifyModuleName(page.id || page.name, `page-${index + 1}`)}`,
    checks: ["页面内容与当前业务需求一致", "关键操作路径可以被人工确认", "沙盒数据可独立演示"],
    labels: ["business", "prototype"],
  }));
}

inferPrototypeScreens = function inferBusinessPrototypeScreens(workflow = {}) {
  return buildBusinessPrototypePages(workflow).map((page) => ({
    id: page.id,
    name: page.name,
    desc: page.purpose,
  }));
};

buildPrototypeHtml = function buildBusinessSpecificPrototypeHtml(workflow = {}) {
  const projectName = workflow.project_name || "业务交付项目";
  const clientName = workflow.client_name || "客户";
  const pages = buildBusinessPrototypePages(workflow);
  const metrics = workflow.metrics || {};
  const requirementDoc = getStageArtifactContent(workflow, "requirement-doc");
  const parameterDoc = getStageArtifactContent(workflow, "parameter-doc");
  const architectureDoc = getStageArtifactContent(workflow, "architecture-doc");
  const docCards = [
    ["需求文档", requirementDoc || "待生成需求文档"],
    ["参数文档", parameterDoc || "待生成参数文档"],
    ["架构文档", architectureDoc || "待生成架构文档"],
  ];

  const nav = pages
    .map((page, index) => `<button class="${index === 0 ? "active" : ""}" data-screen="${escapeHtml(page.id)}">${escapeHtml(page.name)}</button>`)
    .join("");

  const pageSections = pages
    .map((page, index) => {
      const checks = page.checks.length ? page.checks : ["业务信息完整", "操作路径清晰", "可进入沙盒验证"];
      return `
        <section class="screen ${index === 0 ? "active" : ""}" id="screen-${escapeHtml(page.id)}">
          <div class="screen-title">
            <div>
              <p>业务原型页面 ${String(index + 1).padStart(2, "0")}</p>
              <h2>${escapeHtml(page.name)}</h2>
            </div>
            <span>${escapeHtml(page.route)}</span>
          </div>
          <div class="prototype-board">
            <div class="lane">
              <strong>业务输入</strong>
              <p>${escapeHtml(page.purpose)}</p>
              <small>来源：当前业务需求、需求文档、参数文档和架构文档</small>
            </div>
            <div class="lane">
              <strong>页面处理</strong>
              <p>展示页面主流程、状态反馈、Mock 数据和当前页面需要确认的业务信息。</p>
              <small>${escapeHtml(page.apiBase || "Mock API 待生成")}</small>
            </div>
            <div class="lane">
              <strong>人工确认</strong>
              <p>产品经理、业务负责人或测试工程师在本页确认内容后，再进入实施方案、Patch 草案和代码生成。</p>
              <small>${escapeHtml((page.labels || []).join(" / ") || "business / prototype")}</small>
            </div>
            <div class="lane">
              <strong>沙盒验证</strong>
              <p>通过独立沙盒路由访问页面，验证空状态、加载态、成功态、错误态和主操作闭环。</p>
              <small>${escapeHtml(page.route)}</small>
            </div>
          </div>
          <div class="wireframe">
            <aside>
              <b>${escapeHtml(projectName)}</b>
              ${pages.slice(0, 7).map((item) => `<span class="${item.id === page.id ? "current" : ""}">${escapeHtml(item.name)}</span>`).join("")}
            </aside>
            <main>
              <header>
                <div>
                  <small>${escapeHtml(clientName)}</small>
                  <h3>${escapeHtml(page.name)}</h3>
                </div>
                <button>确认并进入下一步</button>
              </header>
              <div class="content-grid">
                <div class="panel wide">
                  <b>当前业务材料</b>
                  <p>${escapeHtml(page.purpose)}</p>
                </div>
                <div class="panel"><b>待确认</b><strong>3</strong><span>业务项</span></div>
                <div class="panel"><b>已生成</b><strong>${index + 1}</strong><span>页面方案</span></div>
                <div class="panel wide">
                  <b>验收检查</b>
                  <ul>${checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul>
                </div>
              </div>
            </main>
          </div>
        </section>
      `;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} - 业务原型图</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f7f2; color: #18211d; font-family: Inter, "Segoe UI", Arial, sans-serif; }
    .app { min-height: 100vh; display: grid; grid-template-columns: 270px minmax(0, 1fr); }
    aside.nav { background: #16332c; color: #fff; padding: 22px; display: grid; align-content: start; gap: 18px; }
    h1, h2, h3, p { margin: 0; }
    .brand h1 { font-size: 18px; line-height: 1.25; }
    .brand p, .muted, small { color: #66746d; line-height: 1.5; }
    aside.nav .brand p { color: #b5cec5; margin-top: 4px; }
    nav { display: grid; gap: 8px; }
    nav button { width: 100%; border: 1px solid rgba(255,255,255,.14); background: transparent; color: #e2f0ec; border-radius: 6px; padding: 10px; text-align: left; cursor: pointer; font: inherit; }
    nav button.active, nav button:hover { background: #226256; border-color: #42c5ad; color: #fff; }
    main.app-main { padding: 22px; display: grid; gap: 16px; }
    .topbar, .hero, .screen, .doc-card { background: #fff; border: 1px solid #d9dfd4; border-radius: 8px; }
    .topbar { padding: 14px 16px; display: flex; justify-content: space-between; gap: 14px; align-items: center; }
    .search { min-width: 280px; max-width: 440px; width: 38vw; border: 1px solid #d9dfd4; background: #fafbf8; border-radius: 6px; padding: 10px 12px; color: #66746d; }
    .hero { padding: 22px; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; }
    .hero h2 { margin-top: 6px; font-size: 30px; letter-spacing: 0; }
    .flow { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .flow div, .doc-card, .lane, .panel { border: 1px solid #d9dfd4; background: #fbfcf9; border-radius: 6px; padding: 12px; }
    .flow b { display: block; color: #0f766e; font-size: 22px; }
    .docs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .doc-card p { margin-top: 8px; color: #66746d; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-line; }
    .screen { display: none; padding: 18px; gap: 14px; }
    .screen.active { display: grid; }
    .screen-title { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .screen-title p { color: #0f766e; font-weight: 800; font-size: 13px; }
    .screen-title h2 { margin-top: 4px; font-size: 23px; }
    .screen-title span { color: #0f766e; background: #eef8f5; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
    .prototype-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .lane strong { display: block; margin-bottom: 8px; }
    .lane p { color: #52615a; line-height: 1.55; min-height: 74px; }
    .wireframe { min-height: 390px; border: 1px solid #d9dfd4; border-radius: 8px; overflow: hidden; display: grid; grid-template-columns: 210px minmax(0, 1fr); background: #fff; }
    .wireframe aside { background: #eef4ef; padding: 16px; display: grid; align-content: start; gap: 9px; }
    .wireframe aside span { border-radius: 6px; padding: 9px; color: #51625a; }
    .wireframe aside span.current { background: #0f766e; color: #fff; }
    .wireframe main { padding: 18px; display: grid; align-content: start; gap: 14px; }
    .wireframe header { display: flex; justify-content: space-between; gap: 14px; align-items: center; }
    button { border: 0; border-radius: 6px; background: #0f766e; color: #fff; padding: 10px 12px; font-weight: 750; cursor: pointer; }
    .content-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .panel.wide { grid-column: 1 / -1; }
    .panel strong { display: block; margin-top: 8px; font-size: 28px; color: #0f766e; }
    .panel p, .panel li, .panel span { color: #52615a; line-height: 1.55; }
    ul { margin: 8px 0 0; padding-left: 18px; }
    @media (max-width: 980px) { .app, .hero, .wireframe { grid-template-columns: 1fr; } .docs, .prototype-board, .content-grid { grid-template-columns: 1fr; } .search { width: 100%; min-width: 0; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="nav">
      <div class="brand">
        <h1>${escapeHtml(projectName)}</h1>
        <p>${escapeHtml(clientName)} · 业务原型图</p>
      </div>
      <nav>${nav}</nav>
    </aside>
    <main class="app-main">
      <header class="topbar">
        <strong>根据当前业务需求生成，不使用通用模板</strong>
        <div class="search">搜索业务页面、沙盒路由、实施任务</div>
      </header>
      <section class="hero">
        <div>
          <p class="muted">首页业务需求 → 文档生成 → 业务原型图 → 业务 UI 图 → 页面实施方案 → Patch 草案 → 代码生成 → 沙盒测试</p>
          <h2>${escapeHtml(projectName)} 业务原型图</h2>
          <p class="muted">本原型直接绑定当前工作流中的页面任务，每个页面都带业务输入、处理路径、人工确认点、Mock API 和沙盒验证入口。</p>
        </div>
        <div class="flow">
          <div><b>${escapeHtml(pages.length)}</b><span>业务页面</span></div>
          <div><b>${escapeHtml(metrics.stories || pages.length)}</b><span>页面任务</span></div>
          <div><b>${escapeHtml(metrics.estimated_sprints || 4)}</b><span>交付迭代</span></div>
          <div><b>PAGE</b><span>按页面生成</span></div>
        </div>
      </section>
      <section class="docs">
        ${docCards.map(([title, content]) => `<div class="doc-card"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(content)}</p></div>`).join("")}
      </section>
      ${pageSections}
    </main>
  </div>
  <script>
    const buttons = Array.from(document.querySelectorAll("nav button"));
    const screens = Array.from(document.querySelectorAll(".screen"));
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        buttons.forEach((item) => item.classList.remove("active"));
        screens.forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        document.getElementById("screen-" + button.dataset.screen)?.classList.add("active");
      });
    });
  </script>
</body>
</html>`;
};

function buildBusinessUiHtml(workflow = {}) {
  const projectName = workflow.project_name || "业务系统";
  const clientName = workflow.client_name || "客户";
  const pages = (workflow.backlog_issues || [])
    .map(normalizeIssueCard)
    .filter((issue) => issue.key?.startsWith("PAGE-"))
    .slice(0, 8)
    .map((issue) => ({
      name: issue.title.replace(/^页面「|」实施方案.*$/g, "") || issue.title,
      purpose: issue.sandbox?.mock_data?.primary_action || "确认并进入下一步",
      route: issue.sandbox?.route || "",
    }));
  const boards = pages.length ? pages : inferBusinessPages({ project_name: projectName });
  const boardCards = boards.map((page, index) => `
    <section class="board ${index === 0 ? "wide" : ""}">
      <div class="board-top">
        <div>
          <p>业务 UI 图 ${String(index + 1).padStart(2, "0")}</p>
          <h2>${escapeHtml(page.name)}</h2>
        </div>
        <span>${escapeHtml(page.route || "Business Board")}</span>
      </div>
      <div class="mock-window">
        <header>
          <b>${escapeHtml(page.name)}</b>
          <div><i></i><i></i><i></i></div>
        </header>
        <main>
          <aside>
            <strong>${escapeHtml(projectName)}</strong>
            <span class="active">当前页面</span>
            <span>业务数据</span>
            <span>审批与交付</span>
            <span>系统配置</span>
          </aside>
          <section>
            <div class="hero-line">
              <div>
                <small>${escapeHtml(clientName)}</small>
                <h3>${escapeHtml(page.name)}</h3>
                <p>${escapeHtml(page.purpose || "围绕业务需求展示关键数据、主操作和状态反馈。")}</p>
              </div>
              <button>提交评审</button>
            </div>
            <div class="toolbar-row">
              <div class="filter-set">
                <span>全部状态</span>
                <span>本周更新</span>
                <span>负责人</span>
                <span>风险优先</span>
              </div>
              <span class="status-pill strong">客户评审版</span>
            </div>
            <div class="stats">
              <div><b>12</b><span>待处理事项</span></div>
              <div><b>5</b><span>需人工复核</span></div>
              <div><b>96%</b><span>流程完整度</span></div>
            </div>
            <div class="content-split">
              <div class="table">
                <div><b>业务对象</b><b>状态</b><b>负责人</b></div>
                <div><span>客户需求基线</span><span>已确认</span><span>需求分析师</span></div>
                <div><span>产品原型评审</span><span>进行中</span><span>产品经理</span></div>
                <div><span>视觉稿确认</span><span>待确认</span><span>UI 设计师</span></div>
                <div><span>沙盒测试入口</span><span>已生成</span><span>开发人员</span></div>
              </div>
              <aside class="insight-panel">
                <b>页面设计重点</b>
                <p>主操作保持在首屏可见，业务状态、负责人和下一步动作必须可以快速扫描。</p>
                <div class="timeline-mini">
                  <span>输入：需求文档与产品原型</span>
                  <span>处理：状态确认与业务操作</span>
                  <span>输出：交给开发人员实施</span>
                </div>
              </aside>
            </div>
          </section>
        </main>
      </div>
    </section>
  `).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} - 业务 UI 图</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef2ef; color: #17201b; font-family: Inter, "Segoe UI", Arial, sans-serif; }
    .wrap { max-width: 1440px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    .cover, .board { background: #fff; border: 1px solid #d7ddd4; border-radius: 8px; box-shadow: 0 18px 45px rgba(22, 33, 27, .08); }
    .cover { padding: 28px; display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; }
    .cover p, .board-top p, small { color: #65706a; margin: 0; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 34px; margin-top: 6px; }
    .tag { background: #0f766e; color: white; border-radius: 999px; padding: 8px 12px; font-weight: 800; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .board { padding: 18px; display: grid; gap: 14px; }
    .board.wide { grid-column: 1 / -1; }
    .board-top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .board-top h2 { font-size: 22px; margin-top: 4px; }
    .board-top span { color: #0f766e; font-size: 12px; font-weight: 800; background: #eef7f5; border-radius: 999px; padding: 6px 9px; }
    .mock-window { border: 1px solid #d7ddd4; border-radius: 8px; overflow: hidden; background: #fbfcfa; }
    .mock-window > header { height: 44px; display: flex; justify-content: space-between; align-items: center; padding: 0 14px; border-bottom: 1px solid #d7ddd4; background: #fff; }
    .mock-window i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #c8ded7; margin-left: 5px; }
    .mock-window main { display: grid; grid-template-columns: 170px minmax(0, 1fr); min-height: 360px; }
    aside { background: #10231f; color: white; padding: 16px; display: grid; align-content: start; gap: 10px; }
    aside span { color: #a8c4bc; padding: 8px 9px; border-radius: 6px; }
    aside span.active { background: #1f4f48; color: white; }
    section section { padding: 18px; display: grid; gap: 14px; }
    .hero-line { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
    .hero-line h3 { font-size: 24px; margin: 5px 0; }
    .hero-line p { color: #65706a; margin: 0; line-height: 1.5; }
    button { border: 0; background: #0f766e; color: white; border-radius: 6px; padding: 10px 13px; font-weight: 800; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .stats div { background: #eef7f5; border: 1px solid #c8ded7; border-radius: 6px; padding: 12px; }
    .stats b { display: block; color: #0f766e; font-size: 24px; }
    .stats span, .table span { color: #65706a; }
    .table { border: 1px solid #d7ddd4; border-radius: 6px; overflow: hidden; }
    .table div { display: grid; grid-template-columns: 1.4fr .8fr .8fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #d7ddd4; background: #fff; }
    .table div:first-child { background: #f4f7f5; }
    .table div:last-child { border-bottom: 0; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .board.wide { grid-column: auto; } .mock-window main { grid-template-columns: 1fr; } aside { display: none; } .cover { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="cover">
      <div>
        <p>业务评审设计稿</p>
        <h1>${escapeHtml(projectName)}业务 UI 图</h1>
        <p>${escapeHtml(clientName)} / 从业务需求到页面级沙盒测试</p>
      </div>
      <span class="tag">${boards.length} 张业务图</span>
    </header>
    <main class="grid">${boardCards}</main>
  </div>
</body>
</html>`;
}

function generateBusinessUiBoards(workflow) {
  if (!workflow) throw new Error("请先运行工作流，再生成业务 UI 图。");
  const previewId = `businessui_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const previewDir = path.join(previewRoot, previewId);
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, "index.html"), buildBusinessUiHtml(workflow), "utf8");
  const boards = (workflow.backlog_issues || [])
    .map(normalizeIssueCard)
    .filter((issue) => issue.key?.startsWith("PAGE-"))
    .slice(0, 8)
    .map((issue) => issue.title.replace(/^页面「|」实施方案.*$/g, ""));
  return {
    preview_id: previewId,
    preview_url: `/preview/${previewId}/`,
    title: `${workflow.project_name || "项目"}业务 UI 图`,
    summary: "已根据业务需求、页面清单和页面级沙盒任务生成业务评审设计稿。",
    boards,
    generated_at: new Date().toISOString(),
  };
}

const BUSINESS_UI_STYLE_PRESETS = {
  "enterprise-saas": {
    label: "企业级 SaaS",
    description: "克制、高信息密度，适合 CRM、项目管理和审批工作台。",
    bg: "#f4f6f8",
    panel: "#ffffff",
    panelSoft: "#f8fafc",
    ink: "#172033",
    muted: "#667085",
    line: "#d7dde6",
    accent: "#2563eb",
    accentDark: "#1d4ed8",
    accentSoft: "#eaf1ff",
    sidebar: "#111827",
    sidebarMuted: "#aeb8c8",
    shadow: "0 18px 44px rgba(15, 23, 42, .10)",
    radius: "8px",
    coverLayout: "split",
  },
  "legal-finance": {
    label: "金融法务专业",
    description: "稳重、强审计感，适合合同、风控、合规和金融后台。",
    bg: "#f6f3ee",
    panel: "#fffdf8",
    panelSoft: "#fbf7ef",
    ink: "#1f2528",
    muted: "#6f6a5f",
    line: "#ded4c4",
    accent: "#7c2d12",
    accentDark: "#5f220d",
    accentSoft: "#fff1e7",
    sidebar: "#201915",
    sidebarMuted: "#d1c4b5",
    shadow: "0 20px 46px rgba(49, 36, 23, .11)",
    radius: "6px",
    coverLayout: "compact",
  },
  "ai-product": {
    label: "科技产品",
    description: "现代、清晰、有数据平台感，适合 AI、数据和研发工具。",
    bg: "#f2f7fb",
    panel: "#ffffff",
    panelSoft: "#f4fbff",
    ink: "#0d1b2a",
    muted: "#52677a",
    line: "#cfe0ea",
    accent: "#0891b2",
    accentDark: "#0e7490",
    accentSoft: "#e6f8fb",
    sidebar: "#082f49",
    sidebarMuted: "#aad4e6",
    shadow: "0 18px 48px rgba(8, 47, 73, .12)",
    radius: "8px",
    coverLayout: "metrics",
  },
  "minimal-premium": {
    label: "极简高端",
    description: "留白更充分，强调客户演示、咨询交付和精致排版。",
    bg: "#f7f7f4",
    panel: "#ffffff",
    panelSoft: "#fbfbf8",
    ink: "#171717",
    muted: "#70706a",
    line: "#deded7",
    accent: "#111111",
    accentDark: "#000000",
    accentSoft: "#f0f0ec",
    sidebar: "#171717",
    sidebarMuted: "#c8c8c0",
    shadow: "0 20px 54px rgba(17, 17, 17, .08)",
    radius: "4px",
    coverLayout: "editorial",
  },
  "ops-console": {
    label: "运营后台",
    description: "接近真实生产后台，突出筛选、表格、状态和重复操作效率。",
    bg: "#f3f5f2",
    panel: "#ffffff",
    panelSoft: "#f7faf6",
    ink: "#162018",
    muted: "#607064",
    line: "#d5dfd2",
    accent: "#15803d",
    accentDark: "#166534",
    accentSoft: "#eaf7ed",
    sidebar: "#102016",
    sidebarMuted: "#b7cfbd",
    shadow: "0 16px 38px rgba(20, 83, 45, .10)",
    radius: "7px",
    coverLayout: "ops",
  },
};

function resolveBusinessUiStyle(styleKey = "") {
  const raw = String(styleKey || "").trim();
  const lowered = raw.toLowerCase();
  let key = BUSINESS_UI_STYLE_PRESETS[raw] ? raw : "";
  if (!key && /(apple|ios|mac|苹果|玻璃|glass|极简|高级|高端|minimal|premium)/i.test(raw)) key = "minimal-premium";
  if (!key && /(ai|科技|数据|研发|developer|tech|cyber|暗色|深色|dark|neon|未来)/i.test(raw)) key = "ai-product";
  if (!key && /(金融|法务|合同|合规|审计|风控|legal|finance|risk|bank)/i.test(raw)) key = "legal-finance";
  if (!key && /(运营|后台|控制台|console|ops|表格|效率|admin|dashboard)/i.test(raw)) key = "ops-console";
  if (!key && /(saas|crm|b2b|企业|管理|审批|项目)/i.test(raw)) key = "enterprise-saas";
  if (!key) key = "enterprise-saas";
  const preset = BUSINESS_UI_STYLE_PRESETS[key];
  return {
    key,
    requested_style: raw,
    ...preset,
    label: raw && !BUSINESS_UI_STYLE_PRESETS[raw] ? `${preset.label} / ${raw}` : preset.label,
    description: raw
      ? `${preset.description} 用户指定风格：${raw}。`
      : preset.description,
  };
}

function businessUiPageName(issue = {}) {
  const title = issue.title || "";
  return (
    title.match(/页面[「《](.*?)[」》]/)?.[1] ||
    issue.sandbox?.mock_data?.page_name ||
    title.replace(/^PAGE-\d+\s*/i, "").replace(/实施方案|Patch|代码生成|沙盒测试|页面|、|，|,/g, " ").replace(/\s+/g, " ").trim() ||
    issue.key ||
    "业务页面"
  );
}

function buildBusinessUiStyleCss(style) {
  return `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: ${style.bg};
      color: ${style.ink};
      font-family: Inter, "Segoe UI", Arial, sans-serif;
    }
    .wrap { max-width: 1480px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    .cover, .board { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; box-shadow: ${style.shadow}; }
    .cover { padding: 28px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 22px; align-items: end; }
    .cover.compact { border-top: 5px solid ${style.accent}; }
    .cover.editorial { align-items: start; padding: 34px; }
    .cover.metrics .cover-metrics, .cover.ops .cover-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .cover p, .board-top p, small { color: ${style.muted}; margin: 0; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 34px; line-height: 1.15; margin-top: 6px; }
    .tag, .chip { background: ${style.accentSoft}; color: ${style.accentDark}; border: 1px solid ${style.line}; border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 900; }
    .style-note { color: ${style.muted}; line-height: 1.55; max-width: 680px; margin-top: 8px; }
    .cover-metrics { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .cover-metrics div { min-width: 96px; background: ${style.panelSoft}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 10px; }
    .cover-metrics b { display: block; color: ${style.accentDark}; font-size: 20px; }
    .cover-metrics span { color: ${style.muted}; font-size: 11px; font-weight: 800; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .board { padding: 18px; display: grid; gap: 14px; }
    .board.wide { grid-column: 1 / -1; }
    .board-top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .board-top h2 { font-size: 22px; line-height: 1.25; margin-top: 4px; }
    .board-top span { color: ${style.accentDark}; font-size: 12px; font-weight: 900; background: ${style.accentSoft}; border-radius: 999px; padding: 6px 9px; overflow-wrap: anywhere; }
    .mock-window { border: 1px solid ${style.line}; border-radius: ${style.radius}; overflow: hidden; background: ${style.panelSoft}; }
    .mock-window > header { height: 44px; display: flex; justify-content: space-between; align-items: center; padding: 0 14px; border-bottom: 1px solid ${style.line}; background: ${style.panel}; }
    .mock-window i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: ${style.accent}; opacity: .45; margin-left: 5px; }
    .mock-window main { display: grid; grid-template-columns: 176px minmax(0, 1fr); min-height: 372px; }
    aside { background: ${style.sidebar}; color: white; padding: 16px; display: grid; align-content: start; gap: 10px; }
    aside strong { line-height: 1.35; }
    aside span { color: ${style.sidebarMuted}; padding: 8px 9px; border-radius: ${style.radius}; font-size: 13px; }
    aside span.active { background: rgba(255,255,255,.12); color: white; }
    section section { padding: 18px; display: grid; gap: 14px; }
    .hero-line { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
    .hero-line h3 { font-size: 24px; line-height: 1.2; margin: 5px 0; }
    .hero-line p { color: ${style.muted}; margin: 0; line-height: 1.5; }
    button { border: 0; background: ${style.accent}; color: white; border-radius: ${style.radius}; padding: 10px 13px; font-weight: 900; }
    .toolbar-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; align-items: center; }
    .filter-set { display: flex; flex-wrap: wrap; gap: 7px; }
    .filter-set span, .status-pill { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: 999px; color: ${style.muted}; font-size: 12px; font-weight: 800; padding: 7px 9px; }
    .status-pill.strong { background: ${style.accentSoft}; color: ${style.accentDark}; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .stats div { background: ${style.accentSoft}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 12px; }
    .stats b { display: block; color: ${style.accentDark}; font-size: 24px; }
    .stats span, .table span { color: ${style.muted}; }
    .content-split { display: grid; grid-template-columns: minmax(0, 1.35fr) 260px; gap: 12px; }
    .table { border: 1px solid ${style.line}; border-radius: ${style.radius}; overflow: hidden; }
    .table div { display: grid; grid-template-columns: 1.4fr .8fr .8fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid ${style.line}; background: ${style.panel}; }
    .table div:first-child { background: ${style.panelSoft}; color: ${style.ink}; }
    .table div:last-child { border-bottom: 0; }
    .insight-panel { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 12px; display: grid; gap: 10px; align-content: start; }
    .insight-panel b { font-size: 14px; }
    .insight-panel p { color: ${style.muted}; line-height: 1.5; margin: 0; }
    .timeline-mini { display: grid; gap: 8px; }
    .timeline-mini span { border-left: 3px solid ${style.accent}; color: ${style.muted}; padding-left: 9px; font-size: 12px; line-height: 1.45; }
    .design-spec { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 16px; display: grid; gap: 12px; }
    .spec-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .spec-grid div { background: ${style.panelSoft}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 12px; }
    .spec-grid b { color: ${style.accentDark}; display: block; margin-bottom: 4px; }
    .spec-grid span { color: ${style.muted}; font-size: 12px; line-height: 1.45; }
    @media (max-width: 900px) {
      .wrap { padding: 18px; }
      .cover, .grid, .content-split, .spec-grid { grid-template-columns: 1fr; }
      .board.wide { grid-column: auto; }
      .mock-window main { grid-template-columns: 1fr; }
      aside { display: none; }
      .hero-line { flex-direction: column; }
      .cover-metrics { justify-content: flex-start; }
    }
  `;
}

buildBusinessUiHtml = function buildStyledBusinessUiHtml(workflow = {}, styleKey = "enterprise-saas") {
  const style = resolveBusinessUiStyle(styleKey);
  const projectName = workflow.project_name || "业务系统";
  const clientName = workflow.client_name || "客户";
  const pages = (workflow.backlog_issues || [])
    .map(normalizeIssueCard)
    .filter((issue) => issue.key?.startsWith("PAGE-"))
    .slice(0, 8)
    .map((issue) => ({
      name: businessUiPageName(issue),
      purpose: issue.sandbox?.mock_data?.primary_action || "围绕业务需求展示关键数据、主操作和状态反馈。",
      route: issue.sandbox?.route || "",
    }));
  const boards = pages.length ? pages : inferBusinessPages({ project_name: projectName });
  const coverClass = `cover ${style.coverLayout}`;
  const boardCards = boards.map((page, index) => `
    <section class="board ${index === 0 ? "wide" : ""}">
      <div class="board-top">
        <div>
          <p>业务 UI 图 ${String(index + 1).padStart(2, "0")}</p>
          <h2>${escapeHtml(page.name)}</h2>
        </div>
        <span>${escapeHtml(page.route || "Business Board")}</span>
      </div>
      <div class="mock-window">
        <header>
          <b>${escapeHtml(page.name)}</b>
          <div><i></i><i></i><i></i></div>
        </header>
        <main>
          <aside>
            <strong>${escapeHtml(projectName)}</strong>
            <span class="active">当前页面</span>
            <span>业务数据</span>
            <span>审批与交付</span>
            <span>系统配置</span>
          </aside>
          <section>
            <div class="hero-line">
              <div>
                <small>${escapeHtml(clientName)}</small>
                <h3>${escapeHtml(page.name)}</h3>
                <p>${escapeHtml(page.purpose || "围绕业务需求展示关键数据、主操作和状态反馈。")}</p>
              </div>
              <button>主操作</button>
            </div>
            <div class="stats">
              <div><b>12</b><span>待处理</span></div>
              <div><b>5</b><span>需复核</span></div>
              <div><b>28</b><span>已完成</span></div>
            </div>
            <div class="table">
              <div><b>业务对象</b><b>状态</b><b>负责人</b></div>
              <div><span>示例业务记录</span><span>待确认</span><span>产品经理</span></div>
              <div><span>生成结果</span><span>已生成</span><span>交付经理</span></div>
              <div><span>沙盒测试</span><span>进行中</span><span>测试工程师</span></div>
            </div>
          </section>
        </main>
      </div>
    </section>
  `).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} - ${escapeHtml(style.label)}业务 UI 图</title>
  <style>${buildBusinessUiStyleCss(style)}</style>
</head>
<body>
  <div class="wrap">
    <header class="${coverClass}">
      <div>
        <span class="chip">${escapeHtml(style.label)}</span>
        <h1>${escapeHtml(projectName)}业务 UI 图</h1>
        <p class="style-note">${escapeHtml(clientName)} / ${escapeHtml(style.description)}</p>
      </div>
      <div class="cover-metrics">
        <div><b>${boards.length}</b><span>业务图</span></div>
        <div><b>PAGE</b><span>页面级生成</span></div>
        <div><b>Mock</b><span>沙盒验证</span></div>
      </div>
    </header>
    <main class="grid">${boardCards}</main>
    <section class="design-spec">
      <h2>设计规范摘要</h2>
      <div class="spec-grid">
        <div><b>信息层级</b><span>首屏呈现目标、状态、主操作和风险提示。</span></div>
        <div><b>组件体系</b><span>导航、筛选、指标、表格、详情面板保持一致。</span></div>
        <div><b>交互状态</b><span>覆盖加载、空态、错误、成功、需人工确认。</span></div>
        <div><b>响应式</b><span>窄屏隐藏侧栏，内容转为单列，按钮不挤压文本。</span></div>
      </div>
    </section>
  </div>
</body>
</html>`;
};

generateBusinessUiBoards = async function generateStyledBusinessUiBoards(workflow, styleKey = "enterprise-saas") {
  if (!workflow) throw new Error("请先运行工作流，再生成业务 UI 图。");
  const style = resolveBusinessUiStyle(styleKey);
  const previewId = `businessui_${style.key}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const previewDir = path.join(previewRoot, previewId);
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, "index.html"), buildBusinessUiHtml(workflow, style.key), "utf8");
  const boards = (workflow.backlog_issues || [])
    .map(normalizeIssueCard)
    .filter((issue) => issue.key?.startsWith("PAGE-"))
    .slice(0, 8)
    .map(businessUiPageName);
  const fallback = {
    preview_id: previewId,
    preview_url: `/preview/${previewId}/`,
    title: `${workflow.project_name || "项目"}业务 UI 图`,
    summary: `已使用「${style.label}」生成专业业务 UI 设计稿，可继续切换风格重新生成。`,
    style_key: style.key,
    style_label: style.label,
    style_description: style.description,
    requested_style: style.requested_style || "",
    available_styles: Object.entries(BUSINESS_UI_STYLE_PRESETS).map(([key, value]) => ({ key, label: value.label })),
    boards,
    generated_at: new Date().toISOString(),
  };
  return runRoleLlmAgent({
    roleId: "ui-designer",
    roleName: "UI 设计师 Agent",
    actionName: "生成业务 UI 图",
    workflow,
    extra: { ui_style: styleKey, resolved_style: style, boards, preview_url: fallback.preview_url },
    fallback,
  });
};

function buildUiDesignerConcept(workflow = {}, styleKey = "enterprise-saas") {
  const style = resolveBusinessUiStyle(styleKey);
  const pages = (workflow.backlog_issues || [])
    .map(normalizeIssueCard)
    .filter((issue) => issue.key?.startsWith("PAGE-"))
    .slice(0, 6)
    .map((issue, index) => ({
      id: issue.key || `PAGE-${String(index + 1).padStart(2, "0")}`,
      name: businessUiPageName(issue),
      purpose: issue.body?.split(/\r?\n/).find((line) => line && !line.startsWith("#")) || "支撑核心业务流程的页面。",
      route: issue.sandbox?.route || "",
      layout: index === 0 ? "工作台总览" : index % 2 ? "表单与审批流" : "列表与详情分栏",
    }));
  const screens = pages.length ? pages : inferBusinessPages({ project_name: workflow.project_name }).slice(0, 6).map((page, index) => ({
    id: `PAGE-${String(index + 1).padStart(2, "0")}`,
    name: page.name,
    purpose: page.purpose,
    route: `/sandbox/pages/${page.id}`,
    layout: index === 0 ? "工作台总览" : "业务页面",
  }));
  const designSystem = {
    name: `${style.label} Design System`,
    tokens: {
      background: style.bg,
      surface: style.panel,
      surface_soft: style.panelSoft,
      text: style.ink,
      muted: style.muted,
      line: style.line,
      accent: style.accent,
      accent_dark: style.accentDark,
      accent_soft: style.accentSoft,
      sidebar: style.sidebar,
      radius: style.radius,
      shadow: style.shadow,
      font: 'Inter, "Segoe UI", Arial, sans-serif',
    },
    typography: [
      { name: "页面标题", size: "28-34px", weight: 800, usage: "页面主标题和设计画板标题" },
      { name: "区块标题", size: "18-22px", weight: 800, usage: "卡片、表格和详情区标题" },
      { name: "正文", size: "14px", weight: 500, usage: "说明、表格和表单辅助信息" },
      { name: "状态标签", size: "12px", weight: 900, usage: "审批状态、优先级和路由标签" },
    ],
    components: [
      { name: "侧边导航", intent: "稳定承载页面切换和业务模块分组" },
      { name: "指标卡片", intent: "展示待办、风险、完成量等高频判断指标" },
      { name: "数据表格", intent: "支撑筛选、比较、批量处理和审计追踪" },
      { name: "审批操作条", intent: "集中呈现提交、退回、确认和下一步动作" },
      { name: "状态标签", intent: "用颜色和文案明确业务进度与风险" },
      { name: "详情抽屉", intent: "在不离开列表的情况下查看上下文和处理记录" },
    ],
  };
  return {
    agent: "UI 设计师 Agent",
    style_key: style.key,
    style_label: style.label,
    style_description: style.description,
    requested_style: style.requested_style || "",
    design_system: designSystem,
    screen_concepts: screens.map((screen, index) => ({
      ...screen,
      visual_focus: index === 0 ? "突出项目全局状态、关键路径和下一步动作。" : "突出当前页面的输入、状态反馈和业务对象处理。",
      primary_components: index === 0 ? ["侧边导航", "指标卡片", "任务流", "风险摘要"] : ["页面标题", "状态标签", "数据表格", "审批操作条"],
      acceptance_notes: ["桌面和移动端不重叠", "主操作始终可见", "状态、风险和负责人可快速扫描"],
    })),
    rationale: [
      `采用「${style.label}」是因为当前项目需要在业务评审时同时呈现专业度、可读性和可落地性。`,
      "信息架构优先保证页面级实施任务、Mock API 和沙盒测试入口可被快速识别。",
      "视觉系统避免营销式表达，强调真实业务系统中的导航、表格、状态、审批和审计场景。",
    ],
  };
}

function buildUiDesignerPreviewHtml(workflow = {}, concept = {}) {
  const style = resolveBusinessUiStyle(concept.style_key);
  const projectName = workflow.project_name || "AI 交付项目";
  const screens = concept.screen_concepts || [];
  const tokens = concept.design_system?.tokens || {};
  const componentCards = (concept.design_system?.components || []).map((component) => `
    <div class="component-card">
      <b>${escapeHtml(component.name)}</b>
      <p>${escapeHtml(component.intent)}</p>
    </div>
  `).join("");
  const firstScreen = screens[0] || { name: "业务工作台", layout: "工作台总览", visual_focus: "展示项目全局状态、关键路径和下一步动作。" };
  const screenCards = screens.map((screen, index) => `
    <section class="screen-card ${index === 0 ? "wide" : ""}">
      <div class="screen-copy">
        <span>${escapeHtml(screen.id)}</span>
        <h2>${escapeHtml(screen.name)}</h2>
        <p>${escapeHtml(screen.visual_focus || screen.purpose)}</p>
      </div>
      <div class="screen-mock">
        <aside>
          <strong>${escapeHtml(projectName)}</strong>
          <i class="active">${escapeHtml(screen.name)}</i>
          <i>业务数据</i>
          <i>审批记录</i>
          <i>沙盒测试</i>
        </aside>
        <main>
          <header>
            <div>
              <small>${escapeHtml(screen.layout)}</small>
              <h3>${escapeHtml(screen.name)}</h3>
            </div>
            <button>确认下一步</button>
          </header>
          <div class="mock-grid">
            <div><b>12</b><span>待处理</span></div>
            <div><b>5</b><span>需复核</span></div>
            <div><b>28</b><span>已完成</span></div>
          </div>
          <div class="mock-table">
            <div><b>业务对象</b><b>状态</b><b>负责人</b></div>
            <div><span>示例记录</span><span>待确认</span><span>产品经理</span></div>
            <div><span>生成产物</span><span>已生成</span><span>交付经理</span></div>
            <div><span>沙盒验证</span><span>进行中</span><span>测试工程师</span></div>
          </div>
        </main>
      </div>
    </section>
  `).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} - UI 设计师 Agent 效果图</title>
  <style>
    ${buildBusinessUiStyleCss(style)}
    .designer-hero { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; box-shadow: ${style.shadow}; padding: 30px; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; align-items: end; }
    .designer-hero h1 { font-size: 36px; }
    .designer-hero p { color: ${style.muted}; line-height: 1.65; margin: 8px 0 0; }
    .showcase { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: stretch; }
    .desktop-frame, .mobile-frame { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; box-shadow: ${style.shadow}; padding: 16px; }
    .desktop-frame .screen-mock { min-height: 440px; }
    .mobile-frame { display: grid; align-content: start; gap: 12px; }
    .phone { border: 1px solid ${style.line}; border-radius: 26px; background: ${style.panelSoft}; padding: 12px; min-height: 520px; display: grid; gap: 12px; align-content: start; }
    .phone-top { height: 28px; width: 88px; border-radius: 999px; background: ${style.ink}; opacity: .12; justify-self: center; }
    .phone-card { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 12px; display: grid; gap: 8px; }
    .phone-card b { color: ${style.accentDark}; }
    .phone-card span { color: ${style.muted}; font-size: 12px; }
    .phone-action { background: ${style.accent}; color: white; border-radius: ${style.radius}; padding: 11px; text-align: center; font-weight: 900; }
    .token-board, .component-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .token-board div, .component-card { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 13px; }
    .token-board span { display: block; color: ${style.muted}; font-size: 12px; font-weight: 800; }
    .token-board b, .component-card b { color: ${style.accentDark}; }
    .component-card p { color: ${style.muted}; line-height: 1.5; margin: 6px 0 0; }
    .screen-card { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; box-shadow: ${style.shadow}; padding: 18px; display: grid; gap: 14px; }
    .screen-card.wide { grid-column: 1 / -1; }
    .screen-copy span { color: ${style.accentDark}; font-size: 12px; font-weight: 900; }
    .screen-copy p { color: ${style.muted}; line-height: 1.55; margin-top: 6px; }
    .screen-mock { border: 1px solid ${style.line}; border-radius: ${style.radius}; overflow: hidden; display: grid; grid-template-columns: 170px minmax(0, 1fr); min-height: 340px; background: ${style.panelSoft}; }
    .screen-mock aside { background: ${style.sidebar}; color: white; padding: 16px; display: grid; align-content: start; gap: 10px; }
    .screen-mock aside i { color: ${style.sidebarMuted}; font-style: normal; border-radius: ${style.radius}; padding: 8px; }
    .screen-mock aside i.active { background: rgba(255,255,255,.13); color: white; }
    .screen-mock main { padding: 16px; display: grid; gap: 14px; align-content: start; }
    .screen-mock header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .screen-mock small { color: ${style.muted}; }
    .mock-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .mock-grid div { background: ${style.accentSoft}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 12px; }
    .mock-grid b { display: block; color: ${style.accentDark}; font-size: 23px; }
    .mock-grid span, .mock-table span { color: ${style.muted}; }
    .mock-table { border: 1px solid ${style.line}; border-radius: ${style.radius}; overflow: hidden; }
    .mock-table div { display: grid; grid-template-columns: 1.4fr .8fr .8fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid ${style.line}; background: ${style.panel}; }
    .mock-table div:first-child { background: ${style.panelSoft}; }
    .rationale { background: ${style.panel}; border: 1px solid ${style.line}; border-radius: ${style.radius}; padding: 18px; }
    .rationale li { color: ${style.muted}; line-height: 1.6; margin: 6px 0; }
    .section-title { display: flex; justify-content: space-between; gap: 12px; align-items: end; }
    .section-title p { color: ${style.muted}; margin: 6px 0 0; }
    @media (max-width: 900px) {
      .designer-hero, .showcase, .token-board, .component-board, .screen-mock { grid-template-columns: 1fr; }
      .screen-card.wide { grid-column: auto; }
      .screen-mock aside { display: none; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="designer-hero">
      <div>
        <span class="chip">UI 设计师 Agent / ${escapeHtml(concept.style_label)}</span>
        <h1>${escapeHtml(projectName)}视觉效果图</h1>
        <p>${escapeHtml(concept.style_description || "")}</p>
      </div>
      <div class="token-board">
        <div><span>主色</span><b>${escapeHtml(tokens.accent || style.accent)}</b></div>
        <div><span>圆角</span><b>${escapeHtml(tokens.radius || style.radius)}</b></div>
        <div><span>页面数</span><b>${screens.length}</b></div>
      </div>
    </section>
    <section class="showcase">
      <div class="desktop-frame">
        <div class="section-title">
          <div>
            <h2>桌面端核心画板</h2>
            <p>${escapeHtml(firstScreen.visual_focus || firstScreen.purpose || "")}</p>
          </div>
          <span class="chip">${escapeHtml(firstScreen.layout || "Desktop")}</span>
        </div>
        <div class="screen-mock">
          <aside>
            <strong>${escapeHtml(projectName)}</strong>
            <i class="active">${escapeHtml(firstScreen.name)}</i>
            <i>需求文档</i>
            <i>产品原型</i>
            <i>沙盒测试</i>
          </aside>
          <main>
            <header>
              <div>
                <small>${escapeHtml(firstScreen.layout || "工作台总览")}</small>
                <h3>${escapeHtml(firstScreen.name)}</h3>
              </div>
              <button>确认设计稿</button>
            </header>
            <div class="toolbar-row">
              <div class="filter-set"><span>全部</span><span>待确认</span><span>高优先级</span></div>
              <span class="status-pill strong">设计评审中</span>
            </div>
            <div class="mock-grid">
              <div><b>18</b><span>页面任务</span></div>
              <div><b>7</b><span>交互状态</span></div>
              <div><b>96%</b><span>可实施度</span></div>
            </div>
            <div class="content-split">
              <div class="mock-table">
                <div><b>设计对象</b><b>状态</b><b>负责人</b></div>
                <div><span>核心工作台</span><span>已完成</span><span>UI 设计师</span></div>
                <div><span>详情抽屉</span><span>待确认</span><span>产品经理</span></div>
                <div><span>响应式规则</span><span>已完成</span><span>开发人员</span></div>
              </div>
              <aside class="insight-panel">
                <b>设计判断</b>
                <p>优先保证业务系统的扫描效率和重复操作体验，减少装饰性视觉噪音。</p>
              </aside>
            </div>
          </main>
        </div>
      </div>
      <aside class="mobile-frame">
        <div class="section-title"><h2>移动端预览</h2><span class="chip">Responsive</span></div>
        <div class="phone">
          <div class="phone-top"></div>
          <div class="phone-card"><b>${escapeHtml(firstScreen.name)}</b><span>移动端保留状态、主操作和关键数据。</span></div>
          <div class="phone-card"><b>待确认 5</b><span>负责人、风险和下一步动作优先显示。</span></div>
          <div class="phone-card"><b>沙盒入口</b><span>${escapeHtml(firstScreen.route || "/sandbox/pages")}</span></div>
          <div class="phone-action">确认下一步</div>
        </div>
      </aside>
    </section>
    <section class="design-spec">
      <div class="section-title">
        <div>
          <h2>设计系统规格</h2>
          <p>交给开发人员时需要保留这些视觉约束，避免实现阶段走样。</p>
        </div>
        <span class="chip">${escapeHtml(concept.design_system?.name || "Design System")}</span>
      </div>
      <div class="spec-grid">
        <div><b>颜色</b><span>${escapeHtml(tokens.accent || style.accent)} / ${escapeHtml(tokens.surface || style.panel)}</span></div>
        <div><b>字体</b><span>${escapeHtml(tokens.font || 'Inter, Segoe UI')}</span></div>
        <div><b>间距</b><span>8px 基准网格，区块间距 16-24px。</span></div>
        <div><b>状态</b><span>加载、空态、错误、成功、需人工确认。</span></div>
      </div>
    </section>
    <section class="component-board">${componentCards}</section>
    <main class="grid">${screenCards}</main>
    <section class="rationale">
      <h2>设计理由</h2>
      <ul>${(concept.rationale || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
  </div>
</body>
</html>`;
}

async function generateUiDesignerConcept(workflow, styleKey = "enterprise-saas") {
  if (!workflow) throw new Error("请先运行工作流，再让 UI 设计师 Agent 生成效果图。");
  const concept = buildUiDesignerConcept(workflow, styleKey);
  const previewId = `uidesigner_${concept.style_key}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const previewDir = path.join(previewRoot, previewId);
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, "index.html"), buildUiDesignerPreviewHtml(workflow, concept), "utf8");
  const fallback = {
    ...concept,
    preview_id: previewId,
    preview_url: `/preview/${previewId}/`,
    title: `${workflow.project_name || "项目"} UI 视觉设计方案`,
    summary: "UI 设计师 Agent 已生成设计系统、页面视觉方案、设计理由和可打开的效果图预览。",
    generated_at: new Date().toISOString(),
  };
  return runRoleLlmAgent({
    roleId: "ui-designer",
    roleName: "UI 设计师 Agent",
    actionName: "生成 UI 视觉设计方案",
    workflow,
    extra: { ui_style: styleKey, preview_url: fallback.preview_url },
    fallback,
  });
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
  return buildDeliveryPackageMarkdown(workflow, { version: null });
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function workflowExportVersions(workflow = {}) {
  if (!workflow) return [];
  return Array.isArray(workflow.delivery_exports) ? workflow.delivery_exports : [];
}

function workflowAuditLog(workflow = {}) {
  if (!workflow) return [];
  return Array.isArray(workflow.delivery_audit_log) ? workflow.delivery_audit_log : [];
}

function publicAuditEvent(event = {}) {
  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    message: event.message,
    export_id: event.export_id || "",
    export_version: event.export_version || "",
    created_at: event.created_at,
    metadata: event.metadata || {},
  };
}

function appendAuditEvent(workflow, event = {}, options = {}) {
  if (!workflow) return null;
  const entry = {
    id: `audit_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    type: event.type || "delivery_event",
    actor: event.actor || "system",
    message: event.message || "交付事件已记录",
    export_id: event.export_id || "",
    export_version: event.export_version || "",
    created_at: new Date().toISOString(),
    metadata: event.metadata || {},
  };
  workflow.delivery_audit_log = [entry, ...workflowAuditLog(workflow)].slice(0, 120);
  if (options.persist !== false) saveWorkflowMutation(workflow);
  return entry;
}

function makeReviewToken() {
  return crypto.randomBytes(16).toString("hex");
}

function publicDeliveryExport(record = {}) {
  const nextRecord = { ...record };
  delete nextRecord.review_token;
  delete nextRecord.readonly_token;
  delete nextRecord.markdown_snapshot;
  return nextRecord;
}

function ensureDeliveryExportTokens(workflow) {
  let changed = false;
  const exports = workflowExportVersions(workflow).map((record) => {
    const nextRecord = { ...record };
    if (!nextRecord.review_token) {
      nextRecord.review_token = makeReviewToken();
      changed = true;
    }
    if (!nextRecord.readonly_token) {
      nextRecord.readonly_token = makeReviewToken();
      changed = true;
    }
    return nextRecord;
  });
  if (changed && workflow) {
    workflow.delivery_exports = exports;
    saveWorkflowMutation(workflow);
  }
  return exports;
}

function findDeliveryExportByToken(token = "") {
  if (!token) return { workflow: currentWorkflow(), record: null, readonly: false };
  const projects = managedProjects.length ? managedProjects : [];
  for (const project of projects) {
    const workflow = project.latest_workflow;
    const exports = ensureDeliveryExportTokens(workflow);
    const record = exports.find(
      (item) =>
        (!item.review_revoked && item.review_token === token) ||
        (!item.readonly_revoked && item.readonly_token === token)
    );
    if (record) return { workflow, record, readonly: record.readonly_token === token };
  }
  const workflow = currentWorkflow();
  const exports = ensureDeliveryExportTokens(workflow);
  const record = exports.find(
    (item) =>
      (!item.review_revoked && item.review_token === token) ||
      (!item.readonly_revoked && item.readonly_token === token)
  );
  return record ? { workflow, record, readonly: record.readonly_token === token } : { workflow: null, record: null, readonly: false };
}

function deliveryExportStatusLabel(status = "draft") {
  return (
    {
      draft: "草稿",
      pending_customer_confirmation: "待客户确认",
      confirmed: "已确认",
      needs_update: "需修改",
    }[status] || "草稿"
  );
}

function buildDeliveryPackageMarkdown(workflow, exportRecord = {}) {
  if (!workflow) return "还没有生成任何工作流。\n";
  const stages = Array.isArray(workflow.stages) ? workflow.stages : [];
  const issues = Array.isArray(workflow.backlog_issues) ? workflow.backlog_issues.map(normalizeIssueCard) : [];
  const employees = Array.isArray(workflow.agent_employees) ? workflow.agent_employees : [];
  const exportLabel = exportRecord.version ? `v${exportRecord.version} ${exportRecord.label || "交付包"}` : "当前交付包";
  const lines = [
    `# ${workflow.project_name || "未命名项目"} AI 软件交付包`,
    "",
    `- 交付包版本：${exportLabel}`,
    `- 工作流 ID：\`${workflow.workflow_id}\``,
    `- 客户：${workflow.client_name || "内部项目"}`,
    `- 生成时间：${workflow.created_at}`,
    `- 导出时间：${exportRecord.exported_at || new Date().toISOString()}`,
    `- 当前状态：${deliveryExportStatusLabel(exportRecord.status)}`,
    `- 生成模式：${workflow.generation_mode || "deterministic"}`,
    ...(workflow.model ? [`- 模型：${workflow.model}`] : []),
    "",
    "## 一、项目概览",
    "",
    `- 项目名称：${workflow.project_name || "未命名项目"}`,
    `- 客户名称：${workflow.client_name || "内部项目"}`,
    `- 所属行业：${workflow.request?.industry || "未填写"}`,
    `- 目标用户：${workflow.request?.target_users || "未填写"}`,
    `- 技术栈：${workflow.request?.tech_stack || "未填写"}`,
    "",
    "### 业务目标",
    "",
    markdownEscape(workflow.request?.goal || "未填写业务目标。"),
    "",
    "### 关键指标",
    "",
    ...Object.entries(workflow.metrics || {}).map(([key, value]) => `- ${titleLabel(key)}：${value}`),
    "",
    "## 二、Agent 产物",
  ];

  for (const item of stages) {
    lines.push("", `### ${item.name || item.id}`, "", markdownEscape(item.summary || ""));
    for (const output of item.artifacts || []) {
      lines.push("", `#### ${output.title || "产物"}`, "", markdownEscape(output.content || ""));
    }
  }

  lines.push("", "## 三、岗位确认状态", "");
  if (employees.length) {
    for (const employee of employees) {
      const outputs = employee.outputs || [];
      const generated = outputs.some((item) => item.content);
      lines.push(`- ${employee.title || employee.id}：${generated ? "已生成产物" : "待生成"}；交付物 ${outputs.length || 0} 项`);
    }
  } else {
    lines.push("- 暂无岗位状态。");
  }

  lines.push("", "## 四、开发 Backlog", "");
  if (issues.length) {
    for (const issue of issues) {
      lines.push(formatIssueCardBody(issue), "");
    }
  } else {
    lines.push("暂无结构化 Backlog。");
  }

  lines.push("", "## 五、下一步", "", ...(workflow.next_actions || []).map((item) => `- ${item}`));
  if (exportRecord.customer_feedback) {
    lines.push("", "## 六、客户反馈", "", markdownEscape(exportRecord.customer_feedback));
  }
  if (exportRecord.change_summary) {
    const summary = exportRecord.change_summary;
    lines.push("", "## 七、版本变更说明", "");
    lines.push(`- 对比基线：${summary.from_version ? `v${summary.from_version}` : "无"}`);
    lines.push(`- 当前版本：v${exportRecord.version || "current"}`);
    lines.push(`- 变更结论：${summary.headline || "本版本为当前交付快照。"}`);
    if (summary.added?.length) lines.push("", "### 新增内容", "", ...summary.added.map((item) => `- ${item}`));
    if (summary.removed?.length) lines.push("", "### 删除内容", "", ...summary.removed.map((item) => `- ${item}`));
    if (summary.changed?.length) lines.push("", "### 修改内容", "", ...summary.changed.map((item) => `- ${item}`));
    if (summary.customer_feedback_status) lines.push("", `- 客户反馈处理：${summary.customer_feedback_status}`);
    if (summary.related_change_issues?.length) lines.push(`- 关联变更任务：${summary.related_change_issues.join("、")}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function markdownToHtml(markdown) {
  const inline = (textValue) =>
    escapeHtml(textValue)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = String(markdown || "").split(/\r?\n/);
  const htmlLines = [];
  let inList = false;
  let inCode = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      if (!inCode) {
        if (inList) {
          htmlLines.push("</ul>");
          inList = false;
        }
        htmlLines.push("<pre><code>");
        inCode = true;
      } else {
        htmlLines.push("</code></pre>");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      htmlLines.push(escapeHtml(rawLine));
      continue;
    }
    if (!line.trim()) {
      if (inList) {
        htmlLines.push("</ul>");
        inList = false;
      }
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (inList) {
        htmlLines.push("</ul>");
        inList = false;
      }
      const level = Math.min(heading[1].length, 4);
      htmlLines.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      htmlLines.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }
    htmlLines.push(`<p>${inline(line)}</p>`);
  }
  if (inList) htmlLines.push("</ul>");
  if (inCode) htmlLines.push("</code></pre>");
  return htmlLines.join("\n");
}

function buildDeliveryPackageHtml(workflow, exportRecord = {}) {
  const markdown = buildDeliveryPackageMarkdown(workflow, exportRecord);
  const title = `${workflow?.project_name || "AI 交付项目"}交付包`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f6f3; color: #17201b; font-family: "Segoe UI", Arial, sans-serif; }
    main { max-width: 980px; margin: 0 auto; padding: 38px 24px 72px; }
    h1, h2, h3, h4 { color: #14231d; line-height: 1.25; margin: 28px 0 12px; }
    h1 { font-size: 34px; border-bottom: 2px solid #174237; padding-bottom: 18px; }
    h2 { font-size: 24px; border-bottom: 1px solid #d8dfd5; padding-bottom: 8px; }
    h3 { font-size: 19px; }
    h4 { font-size: 16px; color: #0f766e; }
    p, li { color: #405047; line-height: 1.72; font-size: 14px; }
    ul { padding-left: 22px; }
    code { background: #eaf1ed; border-radius: 4px; padding: 2px 5px; }
    pre { background: #10231d; color: #e9f3ef; overflow: auto; padding: 16px; border-radius: 8px; }
    .printbar { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 18px; }
    button { border: 0; border-radius: 7px; background: #0f766e; color: #fff; cursor: pointer; font-weight: 800; padding: 10px 14px; }
    @media print { .printbar { display: none; } body { background: #fff; } main { padding: 0; max-width: none; } }
  </style>
</head>
<body>
  <main>
    <div class="printbar"><button onclick="window.print()">打印 / 保存 PDF</button></div>
    ${markdownToHtml(markdown)}
  </main>
</body>
</html>`;
}

function recordDeliveryExport(workflow, format = "markdown") {
  if (!workflow) throw new Error("还没有生成工作流，无法导出交付包。");
  const exports = workflowExportVersions(workflow);
  const record = {
    id: `export_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    version: exports.length + 1,
    label: exports.length ? "客户确认版" : "需求初稿",
    format,
    status: "draft",
    frozen: false,
    review_token: makeReviewToken(),
    readonly_token: makeReviewToken(),
    review_revoked: false,
    readonly_revoked: false,
    review_last_accessed_at: "",
    readonly_last_accessed_at: "",
    customer_feedback: "",
    submitted_at: "",
    confirmed_at: "",
    updated_at: new Date().toISOString(),
    exported_at: new Date().toISOString(),
  };
  const previousRecord = exports[exports.length - 1] || null;
  const markdownSnapshot = buildDeliveryPackageMarkdown(workflow, record);
  record.markdown_snapshot = markdownSnapshot;
  record.snapshot_hash = crypto.createHash("sha256").update(markdownSnapshot).digest("hex").slice(0, 16);
  record.change_summary = buildVersionChangeSummary(workflow, previousRecord, record);
  workflow.delivery_exports = [...exports, record];
  appendAuditEvent(workflow, {
    type: "delivery_exported",
    actor: "delivery_manager",
    message: `导出交付包 v${record.version}（${format === "html" ? "HTML/PDF" : "Markdown"}）。`,
    export_id: record.id,
    export_version: record.version,
    metadata: { format },
  }, { persist: false });
  saveWorkflowMutation(workflow);
  return record;
}

function deliveryExportFilename(workflow, record, format) {
  const safeName = String(workflow?.project_name || "delivery-package")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return `${safeName}-v${record.version}.${format === "html" ? "html" : "md"}`;
}

function comparableMarkdownLines(markdown = "") {
  return String(markdown)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("- 导出时间：") && !line.startsWith("- 交付包版本："));
}

function summarizeLine(line = "") {
  return line.replace(/^#+\s*/, "").replace(/^-\s*/, "").slice(0, 120);
}

function snapshotForCompare(workflow, record) {
  if (!record) return "";
  return record.markdown_snapshot || buildDeliveryPackageMarkdown(workflow, { ...record, change_summary: null });
}

function buildVersionChangeSummary(workflow, fromRecord, toRecord) {
  const fromLines = new Set(comparableMarkdownLines(snapshotForCompare(workflow, fromRecord)));
  const toLines = new Set(comparableMarkdownLines(snapshotForCompare(workflow, toRecord)));
  const added = [...toLines].filter((line) => !fromLines.has(line)).map(summarizeLine).slice(0, 8);
  const removed = [...fromLines].filter((line) => !toLines.has(line)).map(summarizeLine).slice(0, 8);
  const changed = [];
  if (fromRecord && fromRecord.status !== toRecord.status) {
    changed.push(`状态从「${deliveryExportStatusLabel(fromRecord.status)}」变为「${deliveryExportStatusLabel(toRecord.status)}」`);
  }
  if (fromRecord && (fromRecord.customer_feedback || "") !== (toRecord.customer_feedback || "")) {
    changed.push("客户反馈内容发生变化");
  }
  const relatedChangeIssues = (workflow.backlog_issues || [])
    .filter((issue) => (issue.labels || []).includes("customer-change") || /^CR-/.test(issue.key || ""))
    .map((issue) => issue.key || issue.title)
    .filter(Boolean)
    .slice(0, 6);
  const customerFeedbackStatus = toRecord.customer_feedback
    ? toRecord.status === "needs_update"
      ? "客户反馈已记录，等待交付团队处理。"
      : "客户反馈已纳入当前交付版本。"
    : relatedChangeIssues.length
      ? "存在客户变更任务，请核对是否已处理。"
      : "当前版本暂无客户反馈。";
  const headline = fromRecord
    ? `v${toRecord.version} 相比 v${fromRecord.version} 有 ${added.length} 项新增、${removed.length} 项删除、${changed.length} 项状态/反馈变化。`
    : `v${toRecord.version} 是首个交付包版本。`;
  return {
    from_export_id: fromRecord?.id || "",
    from_version: fromRecord?.version || null,
    to_export_id: toRecord.id,
    to_version: toRecord.version,
    headline,
    added,
    removed,
    changed,
    customer_feedback_status: customerFeedbackStatus,
    related_change_issues: relatedChangeIssues,
    generated_at: new Date().toISOString(),
  };
}

function compareDeliveryVersions(workflow, fromId, toId) {
  if (!workflow) throw new Error("还没有生成工作流，无法对比版本。");
  const exports = workflowExportVersions(workflow);
  if (exports.length < 1) throw new Error("还没有可对比的交付包版本。");
  const toRecord = exports.find((item) => item.id === toId) || exports[exports.length - 1];
  const toIndex = exports.findIndex((item) => item.id === toRecord.id);
  const fromRecord = exports.find((item) => item.id === fromId) || exports[toIndex - 1] || null;
  const summary = buildVersionChangeSummary(workflow, fromRecord, toRecord);
  return {
    from: fromRecord ? publicDeliveryExport(fromRecord) : null,
    to: publicDeliveryExport(toRecord),
    summary,
  };
}

function createDeliveryChangeIssue(record, feedback) {
  const version = record?.version || "unknown";
  return normalizeIssueCard({
    key: `CR-${String(version).padStart(2, "0")}`,
    title: `处理交付包 v${version} 客户修改意见`,
    body: `## 背景\n客户对交付包 v${version} 提出修改意见，需要进入下一轮需求澄清、方案调整和研发任务拆解。\n\n## 客户反馈\n${feedback || "客户未填写具体反馈。"}\n\n## 验收标准\n- 已逐条回应客户反馈。\n- 已更新相关 Agent 产物或 Backlog。\n- 已重新导出新版本交付包供客户确认。`,
    labels: ["ai-workflow", "customer-change", "delivery"],
    issue_type: "Change Request",
    priority: "P1",
    owner: "Delivery Manager",
    estimate: "0.5-1 day",
    affected_files: ["交付包", "需求说明", "Backlog"],
    implementation_steps: [
      "梳理客户反馈并归类为需求变更、范围澄清或验收问题",
      "更新对应 Agent 产物和研发 Backlog",
      "重新导出交付包并提交客户确认",
    ],
    acceptance_criteria: [
      "客户反馈均有明确处理结论",
      "新版本交付包包含变更说明",
      "变更任务可被交付经理追踪",
    ],
    test_plan: ["人工复核客户反馈处理记录", "重新导出交付包版本"],
    customer_feedback: feedback || "",
    delivery_export_id: record?.id || "",
  });
}

function updateDeliveryExport(workflow, body = {}) {
  if (!workflow) throw new Error("还没有生成工作流，无法更新交付包状态。");
  ensureDeliveryExportTokens(workflow);
  const exports = workflowExportVersions(workflow);
  const exportIndex = exports.findIndex((item) => item.id === body.export_id);
  if (exportIndex < 0) throw new Error("未找到交付包版本。");

  const current = exports[exportIndex];
  if (current.frozen || current.status === "confirmed") {
    throw new Error("该交付包版本已确认冻结，不能再修改状态。");
  }

  const now = new Date().toISOString();
  const status = body.status || current.status || "draft";
  if (!["draft", "pending_customer_confirmation", "confirmed", "needs_update"].includes(status)) {
    throw new Error("不支持的交付包状态。");
  }

  const customerFeedback = markdownEscape(body.customer_feedback ?? current.customer_feedback ?? "");
  const nextRecord = {
    ...current,
    status,
    customer_feedback: customerFeedback,
    updated_at: now,
  };
  if (status === "pending_customer_confirmation") nextRecord.submitted_at = now;
  if (status === "confirmed") {
    nextRecord.confirmed_at = now;
    nextRecord.frozen = true;
  }

  const nextExports = [...exports];
  nextExports[exportIndex] = nextRecord;
  workflow.delivery_exports = nextExports;

  let changeIssue = null;
  if (status === "needs_update") {
    changeIssue = createDeliveryChangeIssue(nextRecord, customerFeedback);
    const issues = Array.isArray(workflow.backlog_issues) ? workflow.backlog_issues : [];
    const existingIndex = issues.findIndex((item) => item.key === changeIssue.key);
    workflow.backlog_issues = existingIndex >= 0
      ? issues.map((item, index) => (index === existingIndex ? changeIssue : item))
      : [changeIssue, ...issues];
    workflow.next_actions = [
      `处理交付包 v${nextRecord.version} 的客户修改意见，并重新导出确认版本。`,
      ...(workflow.next_actions || []).filter((item) => !String(item).includes(`交付包 v${nextRecord.version}`)),
    ];
  }

  appendAuditEvent(workflow, {
    type: status === "confirmed" ? "delivery_confirmed" : status === "needs_update" ? "delivery_needs_update" : "delivery_submitted",
    actor: body.actor || "delivery_manager",
    message:
      status === "confirmed"
        ? `交付包 v${nextRecord.version} 已确认通过并冻结。`
        : status === "needs_update"
          ? `交付包 v${nextRecord.version} 被标记为需修改。`
          : `交付包 v${nextRecord.version} 已提交客户确认。`,
    export_id: nextRecord.id,
    export_version: nextRecord.version,
    metadata: {
      status,
      feedback_length: customerFeedback.length,
      change_issue_key: changeIssue?.key || "",
    },
  }, { persist: false });
  saveWorkflowMutation(workflow);
  return { export: nextRecord, exports: workflowExportVersions(workflow), change_issue: changeIssue, workflow };
}

function manageDeliveryReviewLink(workflow, body = {}) {
  if (!workflow) throw new Error("还没有生成工作流，无法管理验收链接。");
  ensureDeliveryExportTokens(workflow);
  const exports = workflowExportVersions(workflow);
  const exportIndex = exports.findIndex((item) => item.id === body.export_id);
  if (exportIndex < 0) throw new Error("未找到交付包版本。");

  const action = body.action || "";
  const current = exports[exportIndex];
  const nextRecord = { ...current, updated_at: new Date().toISOString() };
  let message = "";
  let type = "review_link_managed";
  if (action === "regenerate_review") {
    nextRecord.review_token = makeReviewToken();
    nextRecord.review_revoked = false;
    nextRecord.review_last_accessed_at = "";
    message = `交付包 v${nextRecord.version} 的客户确认链接已重新生成。`;
    type = "review_link_regenerated";
  } else if (action === "regenerate_readonly") {
    nextRecord.readonly_token = makeReviewToken();
    nextRecord.readonly_revoked = false;
    nextRecord.readonly_last_accessed_at = "";
    message = `交付包 v${nextRecord.version} 的只读查看链接已重新生成。`;
    type = "readonly_link_regenerated";
  } else if (action === "revoke_review") {
    nextRecord.review_revoked = true;
    message = `交付包 v${nextRecord.version} 的客户确认链接已作废。`;
    type = "review_link_revoked";
  } else if (action === "revoke_readonly") {
    nextRecord.readonly_revoked = true;
    message = `交付包 v${nextRecord.version} 的只读查看链接已作废。`;
    type = "readonly_link_revoked";
  } else if (action === "restore_review") {
    nextRecord.review_revoked = false;
    message = `交付包 v${nextRecord.version} 的客户确认链接已恢复。`;
    type = "review_link_restored";
  } else if (action === "restore_readonly") {
    nextRecord.readonly_revoked = false;
    message = `交付包 v${nextRecord.version} 的只读查看链接已恢复。`;
    type = "readonly_link_restored";
  } else {
    throw new Error("不支持的链接管理操作。");
  }

  const nextExports = [...exports];
  nextExports[exportIndex] = nextRecord;
  workflow.delivery_exports = nextExports;
  appendAuditEvent(workflow, {
    type,
    actor: "delivery_manager",
    message,
    export_id: nextRecord.id,
    export_version: nextRecord.version,
    metadata: { action },
  }, { persist: false });
  saveWorkflowMutation(workflow);
  return { export: nextRecord, exports: workflowExportVersions(workflow), audit_log: workflowAuditLog(workflow).slice(0, 40).map(publicAuditEvent) };
}

function markDeliveryLinkAccess(workflow, record, readonly = false) {
  if (!workflow || !record) return;
  const exports = workflowExportVersions(workflow);
  const exportIndex = exports.findIndex((item) => item.id === record.id);
  if (exportIndex < 0) return;
  const nextRecord = {
    ...exports[exportIndex],
    [readonly ? "readonly_last_accessed_at" : "review_last_accessed_at"]: new Date().toISOString(),
  };
  const nextExports = [...exports];
  nextExports[exportIndex] = nextRecord;
  workflow.delivery_exports = nextExports;
}

function deliveryReviewUrl(req, token) {
  const origin = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
  return `${origin}/client-review?token=${encodeURIComponent(token)}`;
}

function buildClientReviewPayload(req, workflow, record, readonly = false) {
  if (!workflow) throw new Error("还没有生成工作流。");
  const exports = ensureDeliveryExportTokens(workflow);
  const currentRecord = record || exports[exports.length - 1] || null;
  if (!currentRecord) throw new Error("交付团队尚未导出交付包。");
  const issues = Array.isArray(workflow.backlog_issues) ? workflow.backlog_issues : [];
  const employees = Array.isArray(workflow.agent_employees) ? workflow.agent_employees : [];
  return {
    readonly,
    workflow: {
      workflow_id: workflow.workflow_id,
      project_name: workflow.project_name || "未命名项目",
      client_name: workflow.client_name || "内部项目",
      generation_mode: workflow.generation_mode || "deterministic",
      request: {
        goal: workflow.request?.goal || "",
        industry: workflow.request?.industry || "",
        target_users: workflow.request?.target_users || "",
        tech_stack: workflow.request?.tech_stack || "",
      },
      delivery_export: publicDeliveryExport(currentRecord),
      scope: {
        agent_count: employees.length,
        generated_agent_count: employees.filter((item) => (item.outputs || []).some((output) => output.content)).length,
        backlog_count: issues.length,
        change_request_count: issues.filter((issue) => (issue.labels || []).includes("customer-change") || /^CR-/.test(issue.key || "")).length,
      },
      audit_log: workflowAuditLog(workflow).slice(0, 12).map(publicAuditEvent),
    },
    links: {
      review_url: deliveryReviewUrl(req, currentRecord.review_token),
      readonly_url: deliveryReviewUrl(req, currentRecord.readonly_token),
    },
  };
}

function findSandboxIssueBySlug(slug = "") {
  const workflow = managedProjects.find((project) => project.id === activeProjectId)?.latest_workflow || lastRun;
  const issues = (workflow?.backlog_issues || []).map(normalizeIssueCard);
  const issue = issues.find((item) => item.sandbox?.slug === slug || item.sandbox?.route === `/sandbox/pages/${slug}`);
  return { workflow, issue };
}

function sandboxState(slug = "") {
  const { workflow, issue } = findSandboxIssueBySlug(slug);
  const sandbox = issue?.sandbox || pageSandboxContract({ id: slug, name: slug || "沙盒页面" }, 0);
  return {
    sandbox: true,
    project_name: workflow?.project_name || "",
    issue_key: issue?.key || "",
    route: sandbox.route || `/sandbox/pages/${slug}`,
    api_base: sandbox.api_base || `/api/sandbox/pages/${slug}`,
    data: issue?.mock_data || sandbox.mock_data || {},
  };
}

function sandboxPageHtml(slug = "") {
  const { workflow, issue } = findSandboxIssueBySlug(slug);
  const sandbox = issue?.sandbox || {};
  const mock = issue?.mock_data || sandbox.mock_data || {};
  const records = Array.isArray(mock.records) ? mock.records : [];
  const pageName = mock.page_name || issue?.title?.match(/页面[「《](.*?)[」》]/)?.[1] || slug || "沙盒页面";
  const purpose = sandbox.mock_data?.primary_action || issue?.body?.split(/\r?\n/).find((line) => line && !line.startsWith("#")) || "用于验证当前业务页面的状态、数据和主操作。";
  const projectName = workflow?.project_name || "AI 交付项目";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageName)} - 沙盒测试</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f6f3; color: #17201b; font-family: Inter, "Segoe UI", Arial, sans-serif; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 240px minmax(0, 1fr); }
    aside { background: #16332c; color: white; padding: 22px; display: grid; align-content: start; gap: 16px; }
    h1, h2, p { margin: 0; }
    aside h1 { font-size: 18px; line-height: 1.25; }
    aside p { color: #b5cec5; font-size: 13px; line-height: 1.5; }
    aside a { color: white; text-decoration: none; border: 1px solid rgba(255,255,255,.16); border-radius: 7px; padding: 10px; }
    main { padding: 24px; display: grid; gap: 16px; align-content: start; }
    .hero, .card { background: #fff; border: 1px solid #d9dfd4; border-radius: 8px; }
    .hero { padding: 22px; display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
    .hero p { color: #64716b; line-height: 1.6; margin-top: 8px; }
    .tag { color: #115e59; background: #e7f4f1; border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 800; display: inline-block; margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .card { padding: 16px; display: grid; gap: 10px; }
    .card b { color: #115e59; }
    .card p, li, code { color: #64716b; line-height: 1.55; }
    code { overflow-wrap: anywhere; }
    button { border: 0; border-radius: 7px; background: #0f766e; color: white; cursor: pointer; font-weight: 800; padding: 10px 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #d9dfd4; padding: 10px; text-align: left; font-size: 14px; }
    th { color: #303a34; background: #fafbf8; }
    @media (max-width: 900px) { .shell, .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div><h1>${escapeHtml(projectName)}</h1><p>页面级沙盒测试环境</p></div>
      <a href="/">返回工作台</a>
      <a href="${escapeHtml(sandbox.api_base || `/api/sandbox/pages/${slug}`)}/state" target="_blank">查看 Mock API</a>
    </aside>
    <main>
      <section class="hero">
        <div>
          <span class="tag">${escapeHtml(issue?.key || "SANDBOX")}</span>
          <h2>${escapeHtml(pageName)}</h2>
          <p>${escapeHtml(purpose)}</p>
        </div>
        <button id="primaryAction">${escapeHtml(mock.primary_action || "确认并进入下一步")}</button>
      </section>
      <section class="grid">
        <div class="card"><b>页面状态</b><p id="statusText">${escapeHtml(mock.status || "ready_for_review")}</p></div>
        <div class="card"><b>沙盒路由</b><code>${escapeHtml(sandbox.route || `/sandbox/pages/${slug}`)}</code></div>
        <div class="card"><b>Mock API</b><code>${escapeHtml(sandbox.api_base || `/api/sandbox/pages/${slug}`)}</code></div>
      </section>
      <section class="card">
        <b>业务记录</b>
        <table>
          <thead><tr><th>ID</th><th>标题</th><th>状态</th></tr></thead>
          <tbody>${(records.length ? records : [{ id: "item-1", title: "示例业务记录", status: "待确认" }]).map((record) => `<tr><td>${escapeHtml(record.id)}</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(record.status)}</td></tr>`).join("")}</tbody>
        </table>
      </section>
      <section class="card">
        <b>人工验收</b>
        <ul>${(issue?.manual_checks || sandbox.manual_checks || ["页面可独立访问", "Mock API 可返回当前页面数据", "主操作有反馈"]).slice(0, 6).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </section>
    </main>
  </div>
  <script>
    document.getElementById("primaryAction").addEventListener("click", async () => {
      const response = await fetch("${escapeHtml(sandbox.api_base || `/api/sandbox/pages/${slug}`)}/actions/primary", { method: "POST" });
      const data = await response.json();
      document.getElementById("statusText").textContent = data.data?.status || "success";
    });
  </script>
</body>
</html>`;
}

function serveStatic(req, res) {
  if (req.url.startsWith("/preview/")) {
    const parts = req.url.split("?")[0].split("/").filter(Boolean);
    const previewId = parts[1] || "";
    const rest = parts.slice(2).join("/") || "index.html";
    if (!/^(ui|prototype|businessui|uidesigner)_[A-Za-z0-9_-]+$/.test(previewId)) {
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

  const cleanUrl = req.url.split("?")[0];
  const urlPath = cleanUrl === "/" ? "/static/index.html" : cleanUrl === "/client-review" ? "/static/client-review.html" : cleanUrl;
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
        rule_engine_enabled: false,
        github_enabled: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
        jira_enabled: Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY),
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/status") {
      json(res, 200, workflowStatus);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/sandbox/pages/")) {
      const slug = decodeURIComponent(req.url.split("?")[0].split("/").filter(Boolean)[2] || "");
      html(res, 200, sandboxPageHtml(slug));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/sandbox/pages/") && req.url.endsWith("/state")) {
      const parts = req.url.split("?")[0].split("/").filter(Boolean);
      json(res, 200, sandboxState(decodeURIComponent(parts[3] || "")));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/api/sandbox/pages/") && req.url.endsWith("/actions/primary")) {
      const parts = req.url.split("?")[0].split("/").filter(Boolean);
      const state = sandboxState(decodeURIComponent(parts[3] || ""));
      json(res, 200, {
        ...state,
        data: {
          ...(state.data || {}),
          status: "success",
          updated_at: new Date().toISOString(),
        },
        message: "沙盒主操作已模拟完成",
      });
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/api/sandbox/pages/") && req.url.endsWith("/actions/reset")) {
      const parts = req.url.split("?")[0].split("/").filter(Boolean);
      json(res, 200, sandboxState(decodeURIComponent(parts[3] || "")));
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
      const body = cleanWorkflowInput(await readBody(req));
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
      persistState();
      json(res, 200, {
        active_project_id: activeProjectId,
        project: projectSummary(project),
        latest_workflow: project.latest_workflow || null,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/workflows/run") {
      const body = cleanWorkflowInput(await readBody(req));
      lastRun = attachWorkflowToProject(await runWorkflow(body), body);
      json(res, 200, lastRun);
      return;
    }
    if (req.method === "POST" && req.url === "/api/integrations/github/issues") {
      const body = await readBody(req);
      const created = await createGitHubIssues(currentWorkflow(), body.limit);
      json(res, 200, { provider: "github", created });
      return;
    }
    if (req.method === "POST" && req.url === "/api/integrations/jira/issues") {
      const body = await readBody(req);
      const created = await createJiraIssues(currentWorkflow(), body.limit);
      json(res, 200, { provider: "jira", created });
      return;
    }
    if (req.method === "POST" && req.url === "/api/roles/run-agent") {
      const body = await readBody(req);
      const workflow = currentWorkflow();
      const result = await runEmployeeRoleAction(workflow, body);
      if (result.workflow) saveWorkflowMutation(result.workflow);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/plan") {
      const body = await readBody(req);
      const result = await generateImplementationPlan(currentWorkflow(), body.issue_key);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/patch-draft") {
      const body = await readBody(req);
      const result = await generatePatchDraft(currentWorkflow(), body.issue_key, body.implementation_plan);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/implementation/generate-code") {
      const body = await readBody(req);
      const result = await generateCodeDraft(currentWorkflow(), body.issue_key);
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
    if (req.method === "POST" && req.url === "/api/prototypes/generate") {
      const workflow = currentWorkflow();
      const result = await generateProductPrototype(workflow);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/business-ui/generate") {
      const body = await readBody(req);
      const workflow = currentWorkflow();
      if (!workflow) {
        json(res, 400, { error: "请先运行 AI 工作流，再生成业务 UI 图。" });
        return;
      }
      const result = await generateBusinessUiBoards(workflow, body.ui_style);
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/ui-designer/generate") {
      const body = await readBody(req);
      const workflow = currentWorkflow();
      if (!workflow) {
        json(res, 400, { error: "请先运行 AI 工作流，再让 UI 设计师 Agent 生成效果图。" });
        return;
      }
      const result = await generateUiDesignerConcept(workflow, body.ui_style);
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
      text(res, 200, exportMarkdown(currentWorkflow()));
      return;
    }
    if (req.method === "GET" && req.url === "/api/delivery-package/versions") {
      const workflow = currentWorkflow();
      const exports = ensureDeliveryExportTokens(workflow).map((item) => ({
        ...publicDeliveryExport(item),
        review_url: item.review_revoked ? "" : deliveryReviewUrl(req, item.review_token),
        readonly_url: item.readonly_revoked ? "" : deliveryReviewUrl(req, item.readonly_token),
      }));
      json(res, 200, { exports });
      return;
    }
    if (req.method === "GET" && req.url === "/api/delivery-package/audit-log") {
      json(res, 200, { audit_log: workflowAuditLog(currentWorkflow()).slice(0, 40).map(publicAuditEvent) });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/delivery-package/compare")) {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      try {
        json(res, 200, compareDeliveryVersions(currentWorkflow(), url.searchParams.get("from"), url.searchParams.get("to")));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/client-review")) {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const token = url.searchParams.get("token") || "";
      const { workflow, record, readonly } = findDeliveryExportByToken(token);
      try {
        if (token && record) {
          markDeliveryLinkAccess(workflow, record, readonly);
          appendAuditEvent(workflow, {
            type: readonly ? "readonly_link_opened" : "review_link_opened",
            actor: readonly ? "client_readonly" : "client",
            message: `${readonly ? "只读" : "客户确认"}链接已打开：交付包 v${record.version}。`,
            export_id: record.id,
            export_version: record.version,
            metadata: { readonly },
          });
        }
        json(res, 200, buildClientReviewPayload(req, workflow || currentWorkflow(), record, readonly));
      } catch (error) {
        json(res, 404, { error: error.message });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/delivery-package/status") {
      const body = await readBody(req);
      try {
        let workflow = currentWorkflow();
        if (body.token) {
          const found = findDeliveryExportByToken(body.token);
          if (!found.record) throw new Error("验收链接无效或已失效。");
          if (found.readonly) {
            appendAuditEvent(found.workflow, {
              type: "readonly_submit_blocked",
              actor: "client_readonly",
              message: `只读链接尝试提交交付包 v${found.record.version}，已被拒绝。`,
              export_id: found.record.id,
              export_version: found.record.version,
              metadata: { attempted_status: body.status || "" },
            });
            throw new Error("该链接为只读链接，不能提交验收结果。");
          }
          workflow = found.workflow;
          body.export_id = found.record.id;
          body.actor = "client";
        }
        json(res, 200, updateDeliveryExport(workflow, body));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/delivery-package/link") {
      const body = await readBody(req);
      try {
        json(res, 200, manageDeliveryReviewLink(currentWorkflow(), body));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/delivery-package/export")) {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const token = url.searchParams.get("token") || "";
      const found = token ? findDeliveryExportByToken(token) : null;
      if (token && !found?.record) {
        json(res, 403, { error: "验收链接无效或已失效。" });
        return;
      }
      const workflow = found?.workflow || currentWorkflow();
      if (!workflow) {
        json(res, 404, { error: "还没有生成工作流，无法导出交付包。" });
        return;
      }
      const format = url.searchParams.get("format") === "html" ? "html" : "markdown";
      const record = found?.record || recordDeliveryExport(workflow, format);
      if (found?.record) {
        appendAuditEvent(workflow, {
          type: "delivery_downloaded",
          actor: found.readonly ? "client_readonly" : "client",
          message: `客户下载交付包 v${record.version}（${format === "html" ? "HTML/PDF" : "Markdown"}）。`,
          export_id: record.id,
          export_version: record.version,
          metadata: { format, readonly: found.readonly },
        });
      }
      const filename = deliveryExportFilename(workflow, record, format);
      const body = format === "html"
        ? buildDeliveryPackageHtml(workflow, record)
        : buildDeliveryPackageMarkdown(workflow, record);
      res.writeHead(200, {
        "Content-Type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/api/workflows/latest") {
      const latestWorkflow = currentWorkflow();
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
