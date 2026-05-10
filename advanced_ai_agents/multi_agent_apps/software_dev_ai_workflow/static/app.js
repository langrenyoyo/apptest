const form = document.getElementById("workflowForm");
const runButton = document.getElementById("runButton");
const timeline = document.getElementById("timeline");
const metrics = document.getElementById("metrics");
const projectTitle = document.getElementById("projectTitle");
const modeLine = document.getElementById("modeLine");
const backlog = document.getElementById("backlog");
const integrationStatus = document.getElementById("integrationStatus");
const runtimeStatus = document.getElementById("runtimeStatus");
const agentEmployeeBoard = document.getElementById("agentEmployeeBoard");
const githubButton = document.getElementById("githubButton");
const jiraButton = document.getElementById("jiraButton");
const prototypeButton = document.getElementById("prototypeButton");
const prototypePanel = document.getElementById("prototypePanel");
const businessUiButton = document.getElementById("businessUiButton");
const businessUiPanel = document.getElementById("businessUiPanel");
const businessUiStyleSelect = document.getElementById("businessUiStyleSelect");
const uiDesignerButton = document.getElementById("uiDesignerButton");
const uiDesignerPanel = document.getElementById("uiDesignerPanel");
const exportMarkdownButton = document.getElementById("exportMarkdownButton");
const exportHtmlButton = document.getElementById("exportHtmlButton");
const deliveryExportPanel = document.getElementById("deliveryExportPanel");
const projectForm = document.getElementById("projectForm");
const projectList = document.getElementById("projectList");
const projectIdInput = document.getElementById("projectIdInput");
const refreshProjectsButton = document.getElementById("refreshProjectsButton");
const authView = document.getElementById("authView");
const projectHomeView = document.getElementById("projectHomeView");
const workflowView = document.getElementById("workflowView");
const loginForm = document.getElementById("loginForm");
const logoutButton = document.getElementById("logoutButton");
const backToProjectsButton = document.getElementById("backToProjectsButton");
const projectSearchInput = document.getElementById("projectSearchInput");
const activeProjectLine = document.getElementById("activeProjectLine");

let latestWorkflow = null;
let statusTimer = null;
let runtimeConfig = null;
let implementationPlans = {};
let patchDrafts = {};
let latestPrototype = null;
let latestBusinessUi = null;
let latestUiDesigner = null;
let projectsState = { active_project_id: "default", projects: [] };
let projectSearchTerm = "";
let selectedPageIssueKey = "";
let selectedAgentEmployeeId = "";
let agentArtifactState = {};
let requirementActionResult = null;
let uiDesignerActionResult = null;
let roleFlowState = { activeRoleId: "requirements-analyst", confirmed: {}, generated: {} };
let deliveryExportVersions = [];

const roleFlowOrder = ["requirements-analyst", "product-manager", "ui-designer", "architect", "developer", "tester"];
const roleGenerationActionId = "generate-current-role";

function showView(name) {
  authView?.classList.toggle("hidden", name !== "auth");
  projectHomeView?.classList.toggle("hidden", name !== "projects");
  workflowView?.classList.toggle("hidden", name !== "workflow");
}

function isLoggedIn() {
  return localStorage.getItem("aiWorkflowLoggedIn") === "true";
}

function requireLoginView() {
  showView(isLoggedIn() ? "projects" : "auth");
}

function roleFlowIndex(roleId) {
  const index = roleFlowOrder.indexOf(roleId);
  return index < 0 ? roleFlowOrder.length : index;
}

function isRoleUnlocked(roleId) {
  return roleFlowIndex(roleId) <= roleFlowIndex(roleFlowState.activeRoleId);
}

function isRoleGenerated(roleId) {
  return Boolean(roleFlowState.generated?.[roleId]);
}

function roleStatus(roleId) {
  if (roleFlowState.confirmed[roleId]) return "confirmed";
  if (!isRoleUnlocked(roleId)) return "locked";
  return isRoleGenerated(roleId) ? "pending_confirm" : "pending_generate";
}

function roleFlowLabel(roleId) {
  return (
    {
      confirmed: "已确认",
      pending_confirm: "待确认",
      pending_generate: "待生成",
      locked: "待上游确认",
    }[roleStatus(roleId)] || "待生成"
  );
}

function confirmRoleAndAdvance(roleId, result) {
  const currentIndex = roleFlowIndex(roleId);
  roleFlowState.confirmed[roleId] = true;
  roleFlowState.generated[roleId] = true;
  const nextRoleId = roleFlowOrder[currentIndex + 1] || roleId;
  roleFlowState.activeRoleId = nextRoleId;
  if (nextRoleId !== roleId && !roleFlowState.generated[nextRoleId]) {
    roleFlowState.generated[nextRoleId] = false;
  }
  selectedAgentEmployeeId = nextRoleId;
  if (result) integrationStatus.textContent = result;
  renderAgentEmployees(latestWorkflow?.agent_employees || []);
}

function applyRoleAgentWorkflowResult(result) {
  if (result?.workflow) {
    const generatedRoleId = result.generated_role_id || result.role_id || roleFlowState.activeRoleId;
    const nextRoleId = result.next_role_id || generatedRoleId || roleFlowState.activeRoleId;
    const confirmed = { ...roleFlowState.confirmed };
    const generated = { ...roleFlowState.generated, [generatedRoleId]: true };
    latestWorkflow = result.workflow;
    renderWorkflow(result.workflow);
    roleFlowState = { activeRoleId: nextRoleId, confirmed, generated };
    selectedAgentEmployeeId = nextRoleId;
    renderAgentEmployees(latestWorkflow?.agent_employees || []);
  }
}

const agentOrder = [
  "需求分析 Agent",
  "产品经理 Agent",
  "架构师 Agent",
  "研发负责人 Agent",
  "QA 与 Review Agent",
  "交付经理 Agent",
];

function formToJson(formElement) {
  const data = new FormData(formElement);
  return Object.fromEntries(data.entries());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function metricLabel(key) {
  const labels = {
    estimated_sprints: "预计迭代数",
    epics: "业务模块",
    stories: "用户故事",
    risks: "风险项",
    integrations: "集成项",
  };
  return labels[key] || key;
}

function modeLabel(mode) {
  const labels = {
    llm: "真实 LLM Agent 生成",
    multi_agent: "真实多 Agent 团队生成",
    deterministic: "LLM 未启用",
    deterministic_pending: "LLM Agent 生成中",
    deterministic_fallback: "LLM Agent 生成失败",
  };
  return labels[mode] || mode || "未知模式";
}

function formatLocalDateTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN");
}

function renderMetrics(values = {}) {
  if (!metrics) return;
  metrics.innerHTML = Object.entries(values)
    .map(
      ([key, value]) => `
        <div class="metric">
          <strong>${escapeHtml(value)}</strong>
          <span>${escapeHtml(metricLabel(key))}</span>
        </div>
      `
    )
    .join("");
}

function renderProjects() {
  if (!projectList) return;
  const projects = projectsState.projects || [];
  if (!projects.length) {
    projectList.innerHTML = `<div class="project-empty">暂无项目，先创建一个项目。</div>`;
    return;
  }

  projectList.innerHTML = projects
    .map((project) => {
      const active = project.id === projectsState.active_project_id;
      return `
        <button type="button" class="project-card ${active ? "active" : ""}" data-project-id="${escapeHtml(project.id)}">
          <span>
            <strong>${escapeHtml(project.name || "未命名项目")}</strong>
            <small>${escapeHtml([project.client_name, project.industry].filter(Boolean).join(" / ") || "未填写客户信息")}</small>
          </span>
          <em>${escapeHtml(project.workflow_count || 0)} 次工作流</em>
        </button>
      `;
    })
    .join("");
}

function syncActiveProjectToForm(project) {
  if (!project) return;
  projectIdInput.value = project.id;
  const projectNameInput = form.elements.project_name;
  const clientInput = form.elements.client_name;
  const industryInput = form.elements.industry;
  if (projectNameInput && project.name) projectNameInput.value = project.name;
  if (clientInput) clientInput.value = project.client_name || "";
  if (industryInput) industryInput.value = project.industry || "";
}

async function loadProjects() {
  const response = await fetch("/api/projects");
  if (!response.ok) return;
  projectsState = await response.json();
  const activeProject = (projectsState.projects || []).find((project) => project.id === projectsState.active_project_id);
  syncActiveProjectToForm(activeProject);
  renderProjects();
}

async function createProject(event) {
  event.preventDefault();
  const button = projectForm.querySelector("button");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "创建中...";

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToJson(projectForm)),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "创建项目失败");
    projectsState = { active_project_id: data.active_project_id, projects: data.projects };
    syncActiveProjectToForm(data.project);
    renderProjects();
    projectForm.reset();
    integrationStatus.textContent = `已创建并切换到项目：${data.project.name}`;
  } catch (error) {
    integrationStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function selectProject(projectId) {
  const response = await fetch("/api/projects/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  const data = await response.json();
  if (!response.ok) {
    integrationStatus.textContent = data.error || "切换项目失败";
    return;
  }

  projectsState.active_project_id = data.active_project_id;
  syncActiveProjectToForm(data.project);
  renderProjects();
  implementationPlans = {};
  patchDrafts = {};
  if (data.latest_workflow) {
    renderWorkflow(data.latest_workflow);
    integrationStatus.textContent = `已切换到项目：${data.project.name}`;
  } else {
    latestWorkflow = null;
    projectTitle.textContent = data.project.name || "等待生成";
    modeLine.textContent = "当前项目尚未运行工作流";
    metrics.innerHTML = "";
    if (backlog) backlog.innerHTML = "";
    if (timeline) timeline.innerHTML = `
      <div class="empty">
        <h3>当前项目尚未生成工作流</h3>
        <p>填写左侧项目信息并运行 AI 工作流，即可生成交付包和 Backlog。</p>
      </div>
    `;
    integrationStatus.textContent = `已切换到项目：${data.project.name}`;
  }
}

function renderBacklog(issues = []) {
  if (!backlog) return;
  if (!issues.length) {
    backlog.innerHTML = "";
    return;
  }

  backlog.innerHTML = `
    <section class="backlog-panel">
      <div>
        <p class="eyebrow">结构化 Backlog</p>
        <h3>${issues.length} 条可创建 Issue</h3>
      </div>
      <div class="issue-list task-card-list">
        ${issues
          .map(
            (issue) => `
              <article class="issue task-card">
                <header>
                  <div>
                    <strong>${escapeHtml(issue.key)}</strong>
                    <h4>${escapeHtml(issue.title)}</h4>
                  </div>
                  <span class="priority">${escapeHtml(issue.priority || "P2")}</span>
                </header>
                <div class="task-meta">
                  <span>${escapeHtml(issue.owner || "Full-stack Engineer")}</span>
                  <span>${escapeHtml(issue.estimate || "0.5-1 day")}</span>
                  <span>${escapeHtml((issue.labels || ["ai-workflow"]).join(", "))}</span>
                </div>
                ${renderMiniList("涉及文件", issue.affected_files)}
                ${renderMiniList("实施步骤", issue.implementation_steps)}
                ${renderMiniList("测试计划", issue.test_plan)}
                <button type="button" class="generate-code-button" data-code-key="${escapeHtml(issue.key)}">AI 生成代码</button>
                <button type="button" class="plan-button" data-issue-key="${escapeHtml(issue.key)}">生成实施方案</button>
                ${renderImplementationPlan(issue.key)}
                <button type="button" class="patch-button" data-patch-key="${escapeHtml(issue.key)}">生成 Patch 草案</button>
                ${renderPatchDraft(issue.key)}
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderModuleBacklog(issues = []) {
  const modules = groupModuleIssues(issues);
  return `
    <section class="backlog-panel">
      <div>
        <p class="eyebrow">模块化 Backlog</p>
        <h3>${modules.length} 个需求模块</h3>
      </div>
      <div class="module-list">
        ${modules
          .map(
            (module) => `
              <article class="module-card">
                <header class="module-head">
                  <div>
                    <strong>${escapeHtml(module.name)}</strong>
                    <h4>${escapeHtml(module.summary)}</h4>
                  </div>
                  <span>${module.items.length} 项</span>
                </header>
                ${module.frontendIssue ? `<div class="module-actions"><button type="button" class="ui-preview-button" data-module-preview-key="${escapeHtml(module.frontendIssue.key)}">模块 UI 预览</button></div>` : ""}
                <div class="issue-list task-card-list">
                  ${module.items.map((issue) => renderIssueCard(issue)).join("")}
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

renderBacklog = function renderBacklogModuleView(issues = []) {
  if (!backlog) return;
  if (!issues.length) {
    backlog.innerHTML = "";
    return;
  }
  backlog.innerHTML = renderModuleBacklog(issues);
};

function groupModuleIssues(issues = []) {
  const map = new Map();
  for (const issue of issues) {
    const moduleName = issue.title?.match(/「(.+?)」/)?.[1] || issue.title || "未命名模块";
    const current = map.get(moduleName) || { name: moduleName, summary: "", items: [], frontendIssue: null };
    current.items.push(issue);
    if (!current.summary) current.summary = issue.body?.split("\n").find((line) => line && !line.startsWith("##")) || issue.title;
    if ((issue.labels || []).includes("frontend") || /前端/.test(issue.title || "")) current.frontendIssue = issue;
    map.set(moduleName, current);
  }
  return [...map.values()];
}

groupModuleIssues = function groupModuleIssuesByReadableTitle(issues = []) {
  const map = new Map();
  for (const issue of issues) {
    const title = issue.title || "";
    const labels = issue.labels || [];
    const moduleName =
      title.match(/「([^」]+)」/)?.[1] ||
      title.match(/\[([^\]]+)\]/)?.[1] ||
      title
        .replace(/^(实现|补充|新增|完善|开发)\s*/, "")
        .replace(/\s*(后端 API|前端工作流|前端页面|权限校验|审计日志|质量校验).*$/, "")
        .trim() ||
      "未命名模块";
    const current = map.get(moduleName) || { name: moduleName, summary: "", items: [], frontendIssue: null };
    current.items.push(issue);
    if (!current.summary) current.summary = issue.body?.split("\n").find((line) => line && !line.startsWith("##")) || title;
    if (labels.includes("frontend") || /前端|UI|页面|界面|workflow/i.test(title)) current.frontendIssue = issue;
    map.set(moduleName, current);
  }
  return [...map.values()];
};

function renderIssueCard(issue) {
  return `
    <article class="issue task-card">
      <header>
        <div>
          <strong>${escapeHtml(issue.key)}</strong>
          <h4>${escapeHtml(issue.title)}</h4>
        </div>
        <span class="priority">${escapeHtml(issue.priority || "P2")}</span>
      </header>
      <div class="task-meta">
        <span>${escapeHtml(issue.owner || "Full-stack Engineer")}</span>
        <span>${escapeHtml(issue.estimate || "0.5-1 day")}</span>
        <span>${escapeHtml((issue.labels || ["ai-workflow"]).join(", "))}</span>
      </div>
      ${renderMiniList("涉及文件", issue.affected_files)}
      ${renderMiniList("实施步骤", issue.implementation_steps)}
      ${renderMiniList("测试计划", issue.test_plan)}
      <button type="button" class="generate-code-button" data-code-key="${escapeHtml(issue.key)}">AI 生成代码</button>
      <button type="button" class="plan-button" data-issue-key="${escapeHtml(issue.key)}">生成实施方案</button>
      ${renderImplementationPlan(issue.key)}
      <button type="button" class="patch-button" data-patch-key="${escapeHtml(issue.key)}">生成 Patch 草案</button>
      ${renderPatchDraft(issue.key)}
    </article>
  `;
}

function renderSandboxBlock(issue) {
  const sandbox = issue.sandbox;
  if (!sandbox) return "";
  return `
    <section class="sandbox-block">
      <div class="sandbox-head">
        <div>
          <b>沙盒测试契约</b>
          <span>${escapeHtml(sandbox.route || "未指定沙盒入口")}</span>
        </div>
        <code>${escapeHtml(sandbox.mock_data_id || "mock-demo")}</code>
      </div>
      ${renderMiniList("Mock API", sandbox.api_contract || issue.api_contract || [])}
      ${renderMiniList("Mock 数据字段", Object.entries(issue.mock_data || sandbox.mock_data || {}).slice(0, 6).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`))}
      ${renderMiniList("沙盒验证", sandbox.sandbox_tests || issue.test_plan || [])}
      ${renderMiniList("人工验收", sandbox.manual_checks || issue.manual_checks || [])}
    </section>
  `;
}

const renderIssueCardBase = renderIssueCard;
renderIssueCard = function renderSandboxReadyIssueCard(issue) {
  const html = renderIssueCardBase(issue);
  return html.replace(
    '<button type="button" class="generate-code-button"',
    `${renderSandboxBlock(issue)}
      <button type="button" class="generate-code-button"`
  );
};

function renderModuleBacklog(issues = []) {
  const modules = groupModuleIssues(issues);
  return `
    <section class="backlog-panel">
      <div>
        <p class="eyebrow">模块化 Backlog</p>
        <h3>${modules.length} 个需求模块</h3>
      </div>
      <div class="module-list">
        ${modules
          .map(
            (module) => `
              <article class="module-card">
                <header class="module-head">
                  <div>
                    <strong>${escapeHtml(module.name)}</strong>
                    <h4>${escapeHtml(module.summary)}</h4>
                  </div>
                  <span>${module.items.length} 项</span>
                </header>
                ${module.frontendIssue ? `<div class="module-actions"><button type="button" class="ui-preview-button" data-module-preview-key="${escapeHtml(module.frontendIssue.key)}">模块 UI 预览</button></div>` : ""}
                <div class="issue-list task-card-list">
                  ${module.items.map((issue) => renderIssueCard(issue)).join("")}
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

renderModuleBacklog = function renderModuleBacklogWithPreview(issues = []) {
  const modules = groupModuleIssues(issues);
  return `
    <section class="backlog-panel">
      <div>
        <p class="eyebrow">模块化 Backlog</p>
        <h3>${modules.length} 个需求模块</h3>
      </div>
      <div class="module-list">
        ${modules
          .map(
            (module) => `
              <article class="module-card">
                <header class="module-head">
                  <div>
                    <strong>${escapeHtml(module.name)}</strong>
                    <h4>${escapeHtml(module.summary)}</h4>
                  </div>
                  <span>${module.items.length} 项</span>
                </header>
                ${
                  module.frontendIssue
                    ? `<div class="module-actions"><button type="button" class="ui-preview-button" data-module-preview-key="${escapeHtml(module.frontendIssue.key)}">模块 UI 预览</button></div>
                       ${renderUiPreviewResult(patchDrafts[module.frontendIssue.key]?.validation?.ui_preview)}`
                    : ""
                }
                <div class="issue-list task-card-list">
                  ${module.items.map((issue) => renderIssueCard(issue)).join("")}
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
};

function renderMiniList(title, items = []) {
  if (!items.length) return "";
  return `
    <div class="task-section">
      <b>${escapeHtml(title)}</b>
      <ul>
        ${items.slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderImplementationPlan(issueKey) {
  const state = implementationPlans[issueKey];
  if (!state) return "";
  if (state.loading) return `<div class="implementation-plan muted">正在生成实施方案...</div>`;
  if (state.error) return `<div class="implementation-plan error">${escapeHtml(state.error)}</div>`;
  const plan = state.plan;
  return `
    <div class="implementation-plan">
      <strong>${escapeHtml(plan.summary || "实施方案")}</strong>
      ${renderPlanChanges(plan.change_plan || [])}
      ${renderMiniList("执行步骤", plan.steps || [])}
      ${renderMiniList("验证命令", plan.test_commands || [])}
      ${renderMiniList("验收检查", plan.acceptance_checks || [])}
      ${renderMiniList("回滚方案", plan.rollback_plan || [])}
    </div>
  `;
}

function renderPlanChanges(changes = []) {
  if (!changes.length) return "";
  return `
    <div class="task-section">
      <b>文件级变更</b>
      <ul>
        ${changes
          .slice(0, 6)
          .map((item) => `<li><strong>${escapeHtml(item.file || "待确认文件")}</strong>：${escapeHtml(item.reason || "")}</li>`)
          .join("")}
      </ul>
    </div>
  `;
}

function renderPatchDraft(issueKey) {
  const state = patchDrafts[issueKey];
  if (!state) return "";
  if (state.loading) return `<div class="patch-draft muted">正在生成 patch 草案...</div>`;
  if (state.error) return `<div class="patch-draft error">${escapeHtml(state.error)}</div>`;
  const patch = state.patch;
  const validation = state.validation || {};
  const canApply = isPatchValidated(patch, validation);
  return `
    <div class="patch-draft">
      <strong>${escapeHtml(patch.summary || "Patch 草案")}</strong>
      ${(patch.files || [])
        .map(
          (file) => `
            <section class="patch-file">
              <div>${escapeHtml(file.path || "待确认文件")}<span>${escapeHtml(file.purpose || "")}</span></div>
              <pre>${escapeHtml(file.patch || "")}</pre>
            </section>
          `
        )
        .join("")}
      ${renderMiniList("测试命令", patch.test_commands || [])}
      ${renderMiniList("人工检查", patch.manual_checks || [])}
      ${renderMiniList("假设", patch.assumptions || [])}
      ${renderMiniList("风险", patch.risks || [])}
      <button type="button" class="apply-patch-button" data-apply-key="${escapeHtml(issueKey)}">应用 Patch 草案</button>
      ${renderFrontendVisualReview(issueKey, patch, validation)}
      ${renderPatchValidationGate(issueKey, patch, validation)}
      ${renderApplyResult(state.applyResult)}
    </div>
  `;
}

function patchValidationItems(patch) {
  const files = patch.files || [];
  const hasDiff = files.some((file) => String(file.patch || "").trim());
  return [
    {
      key: "files",
      label: `已核对受影响文件：${files.map((file) => file.path).filter(Boolean).join(", ") || "待确认"}`,
      disabled: false,
    },
    {
      key: "diff",
      label: hasDiff ? "已阅读前端展示的 diff 草案，确认没有越界修改" : "Patch 没有 diff 内容，不能应用",
      disabled: !hasDiff,
    },
    {
      key: "tests",
      label: `已确认验证命令：${(patch.test_commands || []).join("；") || "需要手动补充验证命令"}`,
      disabled: false,
    },
    {
      key: "manual",
      label: `已确认人工检查项：${(patch.manual_checks || []).join("；") || "需要人工检查主要页面流程"}`,
      disabled: false,
    },
    {
      key: "risks",
      label: `已阅读风险和假设：${[...(patch.risks || []), ...(patch.assumptions || [])].join("；") || "暂无额外风险说明"}`,
      disabled: false,
    },
  ];
}

function isFrontendPatch(patch) {
  return (patch.files || []).some((file) =>
    /(^|\/|\\)(static|app|src|components|pages|frontend)(\/|\\)|\.(html|css|tsx?|jsx?)$/i.test(file.path || "")
  );
}

function frontendPatchFiles(patch) {
  return (patch.files || []).filter((file) => /(\.html|\.css|\.tsx?|\.jsx?)$/i.test(file.path || ""));
}

function extractAddedLabels(patch) {
  return frontendPatchFiles(patch)
    .flatMap((file) => String(file.patch || "").match(/^\+[^+].+/gm) || [])
    .map((line) => line.replace(/^\+/, "").replace(/<[^>]+>/g, " ").replace(/[{}();]/g, " ").trim())
    .filter((line) => line && !line.startsWith("//") && line.length > 3)
    .slice(0, 6);
}

function frontendValidationComplete(patch, validation = {}) {
  if (!isFrontendPatch(patch)) return true;
  return Boolean(validation.frontend_function && validation.frontend_visual);
}

function isPatchValidated(patch, validation = {}) {
  return frontendValidationComplete(patch, validation) && patchValidationItems(patch)
    .filter((item) => !item.disabled)
    .every((item) => validation[item.key]);
}

function renderFrontendVisualReview(issueKey, patch, validation = {}) {
  if (!isFrontendPatch(patch)) return "";
  const files = frontendPatchFiles(patch).map((file) => file.path).filter(Boolean);
  const labels = extractAddedLabels(patch);
  return `
    <section class="frontend-review">
      <div class="frontend-review-head">
        <div>
          <strong>前端功能与视觉验收</strong>
          <span>每个前端代码草案应用前，先确认功能和视觉效果。</span>
        </div>
        <a href="/" target="_blank">打开页面预览</a>
      </div>
      <div class="frontend-review-grid">
        <div class="visual-preview" aria-label="界面结构预览">
          <div class="preview-toolbar"><span></span><span></span><span></span></div>
          <div class="preview-layout">
            <aside></aside>
            <main>
              <div class="preview-title"></div>
              <div class="preview-row"></div>
              <div class="preview-row short"></div>
              <div class="preview-actions"></div>
            </main>
          </div>
        </div>
        <div class="frontend-review-copy">
          ${renderMiniList("影响前端文件", files)}
          ${renderMiniList("疑似新增界面文案", labels.length ? labels : ["未识别到新增文案，请重点查看 diff 和页面预览"])}
          ${renderMiniList("功能验收点", ["主要操作路径可完成", "加载、成功、失败、禁用状态有反馈", "表单输入和按钮行为符合需求"])}
          ${renderMiniList("视觉验收点", ["布局不重叠、不溢出", "桌面和移动宽度都可读", "颜色、间距、字号与当前工作台一致"])}
        </div>
      </div>
      <div class="frontend-review-actions">
        <label>
          <input type="checkbox" data-validation-key="${escapeHtml(issueKey)}" data-validation-item="frontend_function" ${validation.frontend_function ? "checked" : ""} />
          <span>功能交互正确</span>
        </label>
        <label>
          <input type="checkbox" data-validation-key="${escapeHtml(issueKey)}" data-validation-item="frontend_visual" ${validation.frontend_visual ? "checked" : ""} />
          <span>视觉效果正确</span>
        </label>
      </div>
    </section>
  `;
}

function renderPatchValidationGate(issueKey, patch, validation = {}) {
  const items = patchValidationItems(patch);
  const activeItems = items.filter((item) => !item.disabled);
  const checked = activeItems.filter((item) => validation[item.key]).length;
  return `
    <section class="patch-validation">
      <div class="patch-validation-head">
        <strong>前端验证</strong>
        <span>${checked}/${activeItems.length} 已确认</span>
      </div>
      <p>业务代码生成后必须先在前端完成检查，确认文件、diff、测试命令、人工检查和风险后才能应用到本地工作区。</p>
      <div class="patch-validation-list">
        ${items
          .map(
            (item) => `
              <label class="${item.disabled ? "disabled" : ""}">
                <input
                  type="checkbox"
                  data-validation-key="${escapeHtml(issueKey)}"
                  data-validation-item="${escapeHtml(item.key)}"
                  ${validation[item.key] ? "checked" : ""}
                  ${item.disabled ? "disabled" : ""}
                />
                <span>${escapeHtml(item.label)}</span>
              </label>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderUiPreviewResult(result) {
  if (!result) return "";
  if (result.loading) return `<div class="ui-preview muted">正在生成 UI 预览...</div>`;
  if (result.error) return `<div class="ui-preview error">${escapeHtml(result.error)}</div>`;
  const previewUrl = `${escapeHtml(result.preview_url)}?preview=1`;
  return `
    <div class="ui-preview">
      <div class="ui-preview-bar">
        <strong>${escapeHtml(result.message || "UI 预览已生成")}</strong>
        <a href="${escapeHtml(result.preview_url)}" target="_blank">新窗口打开</a>
      </div>
      <iframe src="${previewUrl}" title="生成代码 UI 预览"></iframe>
    </div>
  `;
}

function renderPatchQuality(quality) {
  if (!quality) return "";
  const klass = quality.valid ? "ok" : "error";
  return `
    <div class="patch-quality ${klass}">
      <strong>${quality.valid ? "Patch 格式可预览" : "Patch 格式不可预览"}</strong>
      ${(quality.file_reports || [])
        .map((item) => `<span>${escapeHtml(item.path || "未知文件")}：${item.valid_unified_diff ? "合法 unified diff" : escapeHtml(item.reason || "不是合法 unified diff")}</span>`)
        .join("")}
    </div>
  `;
}

renderFrontendVisualReview = function renderFrontendVisualReviewWithPreview(issueKey, patch, validation = {}) {
  if (!isFrontendPatch(patch)) return "";
  const files = frontendPatchFiles(patch).map((file) => file.path).filter(Boolean);
  const labels = extractAddedLabels(patch);
  return `
    <section class="frontend-review">
      <div class="frontend-review-head">
        <div>
          <strong>前端功能与视觉验收</strong>
          <span>先生成沙盒 UI 预览，确认功能和视觉效果后再应用 Patch。</span>
        </div>
        <button type="button" class="ui-preview-button" data-preview-key="${escapeHtml(issueKey)}">生成 UI 预览</button>
      </div>
      ${renderUiPreviewResult(validation.ui_preview)}
      ${renderPatchQuality(patch.patch_quality)}
      <div class="frontend-review-grid">
        <div class="visual-preview" aria-label="界面结构预览">
          <div class="preview-toolbar"><span></span><span></span><span></span></div>
          <div class="preview-layout">
            <aside></aside>
            <main>
              <div class="preview-title"></div>
              <div class="preview-row"></div>
              <div class="preview-row short"></div>
              <div class="preview-actions"></div>
            </main>
          </div>
        </div>
        <div class="frontend-review-copy">
          ${renderMiniList("影响前端文件", files)}
          ${renderMiniList("疑似新增界面文案", labels.length ? labels : ["未识别到新增文案，请重点查看 diff 和 UI 预览"])}
          ${renderMiniList("功能验收点", ["主要操作路径可完成", "加载、成功、失败、禁用状态有反馈", "表单输入和按钮行为符合需求"])}
          ${renderMiniList("视觉验收点", ["布局不重叠、不溢出", "桌面和移动宽度都可读", "颜色、间距、字号与当前工作台一致"])}
        </div>
      </div>
      <div class="frontend-review-actions">
        <label>
          <input type="checkbox" data-validation-key="${escapeHtml(issueKey)}" data-validation-item="frontend_function" ${validation.frontend_function ? "checked" : ""} />
          <span>功能交互正确</span>
        </label>
        <label>
          <input type="checkbox" data-validation-key="${escapeHtml(issueKey)}" data-validation-item="frontend_visual" ${validation.frontend_visual ? "checked" : ""} />
          <span>视觉效果正确</span>
        </label>
      </div>
    </section>
  `;
};

function renderApplyResult(result) {
  if (!result) return "";
  return `
    <div class="apply-result">
      <strong>${escapeHtml(result.message || "Patch 已应用")}</strong>
      ${result.diff_stat ? `<pre class="diff-stat">${escapeHtml(result.diff_stat)}</pre>` : ""}
      ${renderMiniList("变更文件", result.changed_files || result.files || [])}
      ${renderMiniList("建议测试", result.suggested_tests || [])}
      ${result.diff ? `<details><summary>查看 git diff</summary><pre class="applied-diff">${escapeHtml(result.diff)}</pre></details>` : ""}
      <div class="patch-decision-actions">
        <button type="button" class="revert-patch-button" data-revert-key="${escapeHtml(result.issue_key || "")}">撤销本次 Patch</button>
        <button type="button" class="commit-draft-button" data-commit-key="${escapeHtml(result.issue_key || "")}">生成提交说明</button>
      </div>
      ${renderRevertResult(result.revertResult)}
      ${renderCommitDraft(result.commitDraft)}
    </div>
  `;
}

function renderRevertResult(result) {
  if (!result) return "";
  return `<div class="revert-result">${escapeHtml(result.message || "Patch 已撤销")}</div>`;
}

function renderCommitDraft(draft) {
  if (!draft) return "";
  return `
    <div class="commit-draft">
      <b>提交说明草稿</b>
      <label>Commit message</label>
      <pre>${escapeHtml(draft.commit_message || "")}</pre>
      <label>PR title</label>
      <pre>${escapeHtml(draft.pr_title || "")}</pre>
      <label>PR description</label>
      <pre>${escapeHtml(draft.pr_description || "")}</pre>
      ${renderMiniList("Review checklist", draft.review_checklist || [])}
      ${renderMiniList("Recommended tests", draft.recommended_tests || [])}
      ${renderMiniList("Risk notes", draft.risk_notes || [])}
    </div>
  `;
}

function renderStages(stages = []) {
  if (!timeline) return;
  if (!stages.length) {
    timeline.innerHTML = `
      <div class="empty">
        <h3>等待工作流结果</h3>
        <p>运行后会生成需求、PRD、架构、实施、质量和交付材料。</p>
      </div>
    `;
    return;
  }

  timeline.innerHTML = stages
    .map(
      (stage) => `
        <article class="stage">
          <div class="stage-head">
            <div>
              <h3>${escapeHtml(stage.name)}</h3>
              <p class="summary">${escapeHtml(stage.summary)}</p>
            </div>
            <div class="owner">${escapeHtml(stage.owner)}</div>
          </div>
          ${(stage.artifacts || [])
            .map(
              (artifact) => `
                <div class="artifact">
                  <h4>${escapeHtml(artifact.title)}</h4>
                  <pre>${escapeHtml(String(artifact.content || "").trim())}</pre>
                </div>
              `
            )
            .join("")}
        </article>
      `
    )
    .join("");
}

function runtimeConfigLine() {
  if (!runtimeConfig) return "";
  const mode = runtimeConfig.llm_enabled ? "真实 Agent 已启用" : "LLM 未启用";
  const source = runtimeConfig.ai_config_source || "env";
  const model = runtimeConfig.openai_model || "未配置模型";
  return `${mode} / ${source} / ${model}`;
}

function renderRuntimeStatus(status = null) {
  if (!runtimeStatus) return;
  const configLine = runtimeConfigLine();
  if (!status && !configLine) {
    runtimeStatus.innerHTML = "";
    return;
  }

  const completed = new Set(status?.completed_agents || []);
  const current = status?.current_agent || "";
  const running = Boolean(status?.running);
  const hasError = Boolean(status?.error);
  const finished = Boolean(status?.finished_at);
  const statusText = hasError
    ? `LLM Agent 生成失败：${status.error}`
    : running
      ? `LLM Agent 正在生成：${current || "准备中"}`
      : finished
        ? "LLM Agent 生成已完成"
        : "等待运行";

  runtimeStatus.innerHTML = `
    <section class="runtime-panel ${hasError ? "error" : running ? "running" : ""}">
      <div class="runtime-copy">
        <strong>${escapeHtml(statusText)}</strong>
        ${configLine ? `<span>${escapeHtml(configLine)}</span>` : ""}
      </div>
      <ol class="agent-progress">
        ${agentOrder
          .map((agent) => {
            const state = completed.has(agent) ? "done" : current === agent ? "active" : "pending";
            return `<li class="${state}"><span></span>${escapeHtml(agent)}</li>`;
          })
          .join("")}
      </ol>
    </section>
  `;
}

function renderAgentEmployees(employees = []) {
  if (!agentEmployeeBoard) return;
  if (!employees.length) {
    agentEmployeeBoard.innerHTML = "";
    return;
  }

  const renderDetailList = (items = []) => {
    if (!items.length) return "";
    return `
      <div class="agent-detail-list">
        ${items
          .map(
            (item) => `
              <article>
                <strong>${escapeHtml(item.title || item)}</strong>
                ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
              </article>
            `
          )
          .join("")}
      </div>
    `;
  };

  const renderSectionGroups = (sections = []) => {
    if (!sections.length) return "";
    return sections
      .map(
        (section) => `
          <section>
            <b>${escapeHtml(section.title || "详细信息")}</b>
            <ul>
              ${(section.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </section>
        `
      )
      .join("");
  };

  const renderEmployeeActions = (employee) => {
    const actions = employee.actions || [];
    if (!actions.length) return "";
    const locked = !isRoleUnlocked(employee.id);
    const generated = isRoleGenerated(employee.id);
    return `
      <section class="agent-action-section ${locked ? "locked" : ""}">
        <b>岗位动作 · ${escapeHtml(roleFlowLabel(employee.id))}</b>
        ${locked ? `<p class="role-lock-note">请先确认上游岗位产物，再进入该岗位生产。</p>` : ""}
        ${!locked && !generated ? `<p class="role-lock-note">该岗位已解锁，点击“生成${escapeHtml(employee.title || "当前岗位")}产物”后才会调用 LLM。</p>` : ""}
        ${
          employee.id === "ui-designer"
            ? `<label class="ui-style-prompt">
                UI 风格
                <input id="uiStylePromptInput" value="企业级 SaaS" placeholder="例如：苹果风、Linear 风、暗色科技、金融法务、极简高端、运营后台" />
              </label>`
            : ""
        }
        <div class="agent-action-list">
          ${
            !locked && !generated
              ? `<button type="button" data-agent-action="${roleGenerationActionId}">
                  生成${escapeHtml(employee.title || "当前岗位")}产物
                </button>`
              : ""
          }
          ${actions
            .map(
              (action) => `
                <button type="button" data-agent-action="${escapeHtml(action.id)}" ${locked || !generated ? "disabled" : ""}>
                  ${escapeHtml(action.label || "执行")}
                </button>
                ${action.description ? `<p>${escapeHtml(action.description)}</p>` : ""}
              `
            )
            .join("")}
        </div>
      </section>
    `;
  };

  const artifactKey = (employee, item, index) => `${employee.id}:${item.stage_id || "planned"}:${item.title || index}`;
  const getArtifactState = (key) => agentArtifactState[key] || { expanded: false, status: "pending" };
  const statusLabel = (status) =>
    ({
      pending: "待确认",
      confirmed: "已确认",
      needs_update: "需补充",
    })[status] || "待确认";

  const renderGeneratedArtifacts = (employee, outputs = []) => {
    if (!outputs.length) return `<p>暂无已生成产物。</p>`;
    return `
      <div class="agent-artifact-list">
        ${outputs
          .map((item, index) => {
            const key = artifactKey(employee, item, index);
            const state = getArtifactState(key);
            const content = String(item.content || item.detail || "该产物暂无正文，可重新运行工作流生成。").trim();
            return `
              <article class="agent-artifact-item ${escapeHtml(state.status)}">
                <header>
                  <button type="button" class="artifact-toggle" data-artifact-toggle="${escapeHtml(key)}">
                    ${state.expanded ? "收起" : "展开"}
                  </button>
                  <div>
                    <strong>${escapeHtml(item.title || item)}</strong>
                    <small>${escapeHtml(item.stage_name || item.kind || "产物")}</small>
                  </div>
                  <em>${escapeHtml(statusLabel(state.status))}</em>
                </header>
                ${
                  state.expanded
                    ? `<pre>${escapeHtml(content)}</pre>
                       <div class="artifact-status-actions">
                         <button type="button" data-artifact-status="${escapeHtml(key)}" data-status-value="confirmed">标记已确认</button>
                         <button type="button" class="secondary" data-artifact-status="${escapeHtml(key)}" data-status-value="needs_update">标记需补充</button>
                         <button type="button" class="secondary" data-artifact-status="${escapeHtml(key)}" data-status-value="pending">标记待确认</button>
                       </div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  };

  const renderRequirementActionResult = (employee) => {
    if (employee.id !== "requirements-analyst" || !requirementActionResult) return "";
    return `
      <section class="requirement-action-result">
        <b>${escapeHtml(requirementActionResult.title)}</b>
        <p>${escapeHtml(requirementActionResult.summary)}</p>
        <ul>
          ${(requirementActionResult.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    `;
  };

  const renderUiDesignerActionResult = (employee) => {
    if (employee.id !== "ui-designer" || !uiDesignerActionResult) return "";
    return `
      <section class="requirement-action-result">
        <b>${escapeHtml(uiDesignerActionResult.title)}</b>
        <p>${escapeHtml(uiDesignerActionResult.summary)}</p>
        <ul>
          ${(uiDesignerActionResult.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    `;
  };

  const selectedIndex = employees.findIndex((employee) => employee.id === selectedAgentEmployeeId);
  const selected = selectedIndex >= 0 ? employees[selectedIndex] : null;
  const renderRoleFlowProgress = () => `
    <div class="role-flow-progress">
      ${roleFlowOrder
        .map((roleId, index) => {
          const employee = employees.find((item) => item.id === roleId);
          if (!employee) return "";
          const state = roleStatus(roleId) === "confirmed" ? "done" : roleId === roleFlowState.activeRoleId ? "active" : roleStatus(roleId) === "pending_generate" ? "ready" : "locked";
          return `<span class="${state}"><b>${String(index + 1).padStart(2, "0")}</b>${escapeHtml(employee.title)}</span>`;
        })
        .join("")}
    </div>
  `;
  const renderFullEmployeeCard = (employee, index, detailMode = false) => {
    const upstream = index > 0 ? employees[index - 1] : null;
    const downstream = index < employees.length - 1 ? employees[index + 1] : null;
    const outputs = employee.outputs || [];
    const deliverables = employee.deliverables || [];
    const deliverableDetails = employee.deliverable_details || [];
    const detailSections = employee.detail_sections || [];
    const locked = !isRoleUnlocked(employee.id);
    const acceptanceCriteria = employee.acceptance_criteria || [
      "产物能被下游岗位直接使用",
      "风险、状态和负责人清晰",
      "保留人工确认和沙盒验证入口",
    ];
    return `
      <article class="agent-role-card ${detailMode ? "detail-mode" : ""} ${locked ? "locked" : ""} ${escapeHtml(employee.status || "pending")}">
        <header>
          <span>${String(employee.order || "").padStart(2, "0")}</span>
          <div>
            <p class="eyebrow">${escapeHtml(employee.agent_name || "")}</p>
            <h4>${escapeHtml(employee.title || "Agent 员工")}</h4>
          </div>
          <em>${escapeHtml(roleFlowLabel(employee.id))}</em>
        </header>
        <div class="agent-card-sections">
          <section>
            <b>职责</b>
            <p>${escapeHtml(employee.responsibility || "")}</p>
          </section>
          <section>
            <b>当前任务</b>
            <p>${escapeHtml(employee.current_task || employee.responsibility || "")}</p>
          </section>
          ${renderEmployeeActions(employee)}
          ${renderRequirementActionResult(employee)}
          ${renderUiDesignerActionResult(employee)}
          <section>
            <b>岗位交付物</b>
            ${
              deliverableDetails.length
                ? renderDetailList(deliverableDetails)
                : `<div class="agent-output-list">${deliverables.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
            }
          </section>
          ${renderSectionGroups(detailSections)}
          <section>
            <b>已生成产物</b>
            ${renderGeneratedArtifacts(employee, outputs)}
          </section>
          <section class="agent-flow-section">
            <b>上下游</b>
            <p>输入：${escapeHtml(upstream ? `${upstream.title} / ${upstream.agent_name}` : "客户原始业务需求")}</p>
            <p>交付：${escapeHtml(downstream ? `${downstream.title} / ${downstream.agent_name}` : "客户验收与项目交付包")}</p>
          </section>
          <section>
            <b>验收关注</b>
            <ul>
              ${acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </section>
          ${employee.id === "product-manager" ? `<section class="agent-prototype-section"><b>产品原型预览</b><div id="prototypePanel" class="prototype-panel"></div></section>` : ""}
          ${
            employee.id === "ui-designer"
              ? `<section class="agent-prototype-section"><b>业务 UI 图预览</b><div id="businessUiPanel" class="prototype-panel"></div></section>
                 <section class="agent-prototype-section"><b>UI 视觉设计方案</b><div id="uiDesignerPanel" class="prototype-panel"></div></section>`
              : ""
          }
        </div>
      </article>
    `;
  };

  if (selected) {
    agentEmployeeBoard.innerHTML = `
      <section class="agent-employees-panel agent-employee-detail-page">
        <div class="agent-employees-head">
          <div>
            <p class="eyebrow">Agent 员工详情页</p>
            <h3>${escapeHtml(selected.title || "员工详情")}</h3>
            <p>该员工的所有详情及交付物已按分类放在员工卡片内。</p>
          </div>
          <button type="button" class="secondary" data-agent-back>返回员工列表</button>
        </div>
        ${renderRoleFlowProgress()}
        ${renderFullEmployeeCard(selected, selectedIndex, true)}
      </section>
    `;
    if (selected.id === "product-manager") renderPrototypePanel();
    if (selected.id === "ui-designer") {
      renderBusinessUiPanel();
      renderUiDesignerPanel();
    }
    return;
  }

  agentEmployeeBoard.innerHTML = `
    <section class="agent-employees-panel">
      <div class="agent-employees-head">
        <div>
          <p class="eyebrow">Agent 员工岗位索引</p>
          <h3>点击员工卡片进入详情页</h3>
          <p>员工列表展示岗位摘要，进入详情页后可查看该员工的全部分类详情和交付物。</p>
        </div>
      </div>
      ${renderRoleFlowProgress()}
      <div class="agent-employee-card-grid">
        ${employees
          .map((employee) => {
            const outputs = employee.outputs || [];
            const deliverables = employee.deliverables || [];
            const locked = !isRoleUnlocked(employee.id);
            return `
              <button type="button" class="agent-role-entry-card ${locked ? "locked" : ""} ${escapeHtml(employee.status || "pending")}" data-agent-detail-id="${escapeHtml(employee.id)}">
                <header>
                  <span>${String(employee.order || "").padStart(2, "0")}</span>
                  <div>
                    <p class="eyebrow">${escapeHtml(employee.agent_name || "")}</p>
                    <h4>${escapeHtml(employee.title || "Agent 员工")}</h4>
                  </div>
                  <em>${escapeHtml(roleFlowLabel(employee.id))}</em>
                </header>
                <p>${escapeHtml(employee.responsibility || "")}</p>
                <div class="agent-output-list">
                  ${deliverables.slice(0, 3).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
                  ${outputs.length ? `<span>${outputs.length} 个已生成产物</span>` : ""}
                </div>
              </button>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderWorkflow(workflow) {
  latestWorkflow = workflow;
  selectedPageIssueKey = "";
  selectedAgentEmployeeId = "";
  agentArtifactState = {};
  requirementActionResult = null;
  uiDesignerActionResult = null;
  roleFlowState = { activeRoleId: "requirements-analyst", confirmed: {}, generated: { "requirements-analyst": true } };
  projectTitle.textContent = workflow.project_name || "未命名项目";
  modeLine.textContent = `${modeLabel(workflow.generation_mode)}${workflow.model ? ` / ${workflow.model}` : ""}`;
  integrationStatus.textContent = workflow.generation_error
    ? `AI 生成失败：${workflow.generation_error}`
    : "";
  renderAgentEmployees(workflow.agent_employees || []);
}

const renderWorkflowBase = renderWorkflow;

function renderDeliveryExportPanel(exports = deliveryExportVersions) {
  if (!deliveryExportPanel) return;
  if (!latestWorkflow) {
    deliveryExportPanel.innerHTML = "";
    return;
  }
  const versions = Array.isArray(exports) ? exports.slice().reverse() : [];
  if (!versions.length) {
    deliveryExportPanel.innerHTML = `
      <div>
        <p class="eyebrow">交付包版本</p>
        <strong>尚未导出</strong>
      </div>
      <span>生成工作流后可导出 Markdown 或 HTML/PDF，用于客户确认和内部归档。</span>
    `;
    return;
  }
  deliveryExportPanel.innerHTML = `
    <div>
      <p class="eyebrow">交付包版本</p>
      <strong>已导出 ${versions.length} 个版本</strong>
    </div>
    <div class="export-version-list">
      ${versions
        .slice(0, 5)
        .map(
          (item) => `
            <span>
              <b>v${escapeHtml(item.version || "-")}</b>
              ${escapeHtml(item.label || "交付包")}
              <em>${escapeHtml(item.format || "markdown")} · ${escapeHtml(formatLocalDateTime(item.exported_at))}</em>
            </span>
          `
        )
        .join("")}
    </div>
  `;
}

async function loadDeliveryExportVersions() {
  if (!latestWorkflow) {
    deliveryExportVersions = [];
    renderDeliveryExportPanel();
    return;
  }
  const response = await fetch("/api/delivery-package/versions");
  const data = await readJsonResponse(response, "读取交付包版本失败");
  deliveryExportVersions = data.exports || [];
  renderDeliveryExportPanel();
}

async function exportDeliveryPackage(format, button) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再导出交付包。";
    return;
  }
  const original = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "导出中...";
  }
  try {
    const response = await fetch(`/api/delivery-package/export?format=${encodeURIComponent(format)}`);
    if (!response.ok) {
      const data = await readJsonResponse(response, "导出交付包失败");
      throw new Error(data.error || "导出交付包失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const filename =
      decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "") ||
      (format === "html" ? "delivery-package.html" : "delivery-package.md");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    integrationStatus.textContent = format === "html"
      ? "HTML 交付包已导出，可在浏览器中打印或保存为 PDF。"
      : "Markdown 交付包已导出。";
    await loadDeliveryExportVersions().catch(() => {});
  } catch (error) {
    integrationStatus.textContent = error.message;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function pageIssueName(issue = {}) {
  const title = issue.title || "";
  return (
    title.match(/页面[「《](.*?)[」》]/)?.[1] ||
    issue.sandbox?.mock_data?.page_name ||
    title.replace(/^PAGE-\d+\s*/i, "").replace(/实施方案|Patch|代码生成|沙盒测试|页面|、|，|,/g, " ").replace(/\s+/g, " ").trim() ||
    issue.key ||
    "未命名页面"
  );
}

function pageIssuePurpose(issue = {}) {
  const bodyLine = String(issue.body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !/^\d+\./.test(line) && !line.startsWith("- "));
  return issue.sandbox?.mock_data?.primary_action || bodyLine || "按当前业务流程生成页面实施、Patch、代码和沙盒测试任务。";
}

function renderPageIssueListItem(issue, index, active) {
  const sandbox = issue.sandbox || {};
  return `
    <button type="button" class="page-list-item ${active ? "active" : ""}" data-select-page-key="${escapeHtml(issue.key)}">
      <span class="page-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="page-list-copy">
        <strong>${escapeHtml(pageIssueName(issue))}</strong>
        <small>${escapeHtml(issue.owner || "Full-stack Engineer")} · ${escapeHtml(issue.estimate || "0.5-1 day")}</small>
        <small>${escapeHtml(sandbox.route || issue.key || "待生成沙盒入口")}</small>
      </span>
      <em>${escapeHtml(issue.priority || "P2")}</em>
    </button>
  `;
}

function renderPageIssueDetail(issue) {
  if (!issue) {
    return `
      <section class="page-detail-empty">
        <h3>选择一个页面查看详情</h3>
        <p>左侧按页面列出实施任务，点击后可查看业务目标、沙盒契约、实施步骤、测试计划，并生成实施方案、Patch 草案和代码。</p>
      </section>
    `;
  }
  const sandbox = issue.sandbox || {};
  return `
    <article class="page-detail">
      <header class="page-detail-head">
        <div>
          <p class="eyebrow">${escapeHtml(issue.key || "PAGE")}</p>
          <h3>${escapeHtml(pageIssueName(issue))}</h3>
          <p>${escapeHtml(pageIssuePurpose(issue))}</p>
        </div>
        <span class="priority">${escapeHtml(issue.priority || "P2")}</span>
      </header>

      <div class="page-detail-meta">
        <span>${escapeHtml(issue.owner || "Full-stack Engineer")}</span>
        <span>${escapeHtml(issue.estimate || "0.5-1 day")}</span>
        <span>${escapeHtml((issue.labels || ["page", "sandbox"]).join(" / "))}</span>
      </div>

      ${sandbox.route ? `
        <section class="page-route-card">
          <div>
            <b>沙盒页面</b>
            <code>${escapeHtml(sandbox.route)}</code>
          </div>
          <div>
            <b>Mock API</b>
            <code>${escapeHtml(sandbox.api_base || "待生成")}</code>
          </div>
        </section>
      ` : ""}

      ${renderSandboxBlock(issue)}

      <div class="page-detail-grid">
        ${renderMiniList("涉及文件", issue.affected_files)}
        ${renderMiniList("实施步骤", issue.implementation_steps)}
        ${renderMiniList("测试计划", issue.test_plan)}
        ${renderMiniList("验收标准", issue.acceptance_criteria)}
      </div>

      <section class="page-actions-panel">
        <button type="button" class="generate-code-button" data-code-key="${escapeHtml(issue.key)}">AI 生成代码</button>
        <button type="button" class="plan-button" data-issue-key="${escapeHtml(issue.key)}">生成实施方案</button>
        <button type="button" class="patch-button" data-patch-key="${escapeHtml(issue.key)}">生成 Patch 草案</button>
      </section>

      ${renderImplementationPlan(issue.key)}
      ${renderPatchDraft(issue.key)}
    </article>
  `;
}

renderBacklog = function renderPageBacklogListView(issues = []) {
  if (!backlog) return;
  backlog.innerHTML = "";
};

function renderPrototypePanel(result = latestPrototype) {
  const activePrototypePanel = document.getElementById("prototypePanel");
  if (!activePrototypePanel) return;
  if (!result) {
    activePrototypePanel.innerHTML = "";
    return;
  }
  if (result.loading) {
    activePrototypePanel.innerHTML = `
      <section class="prototype-card">
        <div>
          <p class="eyebrow">产品原型</p>
          <h3>正在根据需求生成原型...</h3>
        </div>
      </section>
    `;
    return;
  }
  if (result.error) {
    activePrototypePanel.innerHTML = `
      <section class="prototype-card error">
        <div>
          <p class="eyebrow">产品原型</p>
          <h3>原型生成失败</h3>
          <p>${escapeHtml(result.error)}</p>
        </div>
      </section>
    `;
    return;
  }

  activePrototypePanel.innerHTML = `
    <section class="prototype-card">
      <div class="prototype-copy">
        <p class="eyebrow">产品原型</p>
        <h3>${escapeHtml(result.title || "需求驱动产品原型")}</h3>
        <p>${escapeHtml(result.summary || "已根据当前项目需求生成可点击产品原型。")}</p>
        <div class="prototype-meta">
          ${(result.screens || []).map((screen) => `<span>${escapeHtml(screen)}</span>`).join("")}
        </div>
      </div>
      <div class="prototype-actions">
        <a class="export" href="${escapeHtml(result.preview_url)}" target="_blank">打开原型</a>
        <a class="secondary link-button" href="${escapeHtml(result.preview_url)}?embed=1" target="_blank">演示视图</a>
      </div>
      <iframe src="${escapeHtml(result.preview_url)}?embed=1" title="产品原型预览"></iframe>
    </section>
  `;
}

function renderBusinessUiPanel(result = latestBusinessUi) {
  const activeBusinessUiPanel = document.getElementById("businessUiPanel");
  if (!activeBusinessUiPanel) return;
  if (!result) {
    activeBusinessUiPanel.innerHTML = "";
    return;
  }
  if (result.loading) {
    activeBusinessUiPanel.innerHTML = `
      <section class="prototype-card">
        <div>
          <p class="eyebrow">业务 UI 图</p>
          <h3>正在生成业务设计图...</h3>
        </div>
      </section>
    `;
    return;
  }
  if (result.error) {
    activeBusinessUiPanel.innerHTML = `
      <section class="prototype-card error">
        <div>
          <p class="eyebrow">业务 UI 图</p>
          <h3>业务 UI 图生成失败</h3>
          <p>${escapeHtml(result.error)}</p>
        </div>
      </section>
    `;
    return;
  }
  activeBusinessUiPanel.innerHTML = `
    <section class="prototype-card business-ui-card">
      <div class="prototype-copy">
        <p class="eyebrow">业务 UI 图</p>
        <h3>${escapeHtml(result.title || "业务场景 UI 设计图")}</h3>
        <p>${escapeHtml(result.summary || "已根据业务需求生成设计画板。")}</p>
        <div class="prototype-meta">
          ${result.style_label ? `<span>视觉风格：${escapeHtml(result.style_label)}</span>` : ""}
          ${(result.boards || []).map((board) => `<span>${escapeHtml(board)}</span>`).join("")}
        </div>
      </div>
      <div class="prototype-actions">
        <a class="export" href="${escapeHtml(result.preview_url)}" target="_blank">打开设计图</a>
        <a class="secondary link-button" href="${escapeHtml(result.preview_url)}?embed=1" target="_blank">演示视图</a>
      </div>
      <iframe src="${escapeHtml(result.preview_url)}?embed=1" title="业务 UI 设计图预览"></iframe>
    </section>
  `;
}

function renderUiDesignerPanel(result = latestUiDesigner) {
  const activeUiDesignerPanel = document.getElementById("uiDesignerPanel");
  if (!activeUiDesignerPanel) return;
  if (!result) {
    activeUiDesignerPanel.innerHTML = "";
    return;
  }
  if (result.loading) {
    activeUiDesignerPanel.innerHTML = `
      <section class="prototype-card">
        <div>
          <p class="eyebrow">UI 设计师 Agent</p>
          <h3>正在生成视觉设计方案...</h3>
        </div>
      </section>
    `;
    return;
  }
  if (result.error) {
    activeUiDesignerPanel.innerHTML = `
      <section class="prototype-card error">
        <div>
          <p class="eyebrow">UI 设计师 Agent</p>
          <h3>设计方案生成失败</h3>
          <p>${escapeHtml(result.error)}</p>
        </div>
      </section>
    `;
    return;
  }
  const tokens = result.design_system?.tokens || {};
  const components = result.design_system?.components || [];
  activeUiDesignerPanel.innerHTML = `
    <section class="prototype-card ui-designer-card">
      <div class="prototype-copy">
        <p class="eyebrow">UI 设计师 Agent</p>
        <h3>${escapeHtml(result.title || "专业 UI 视觉设计方案")}</h3>
        <p>${escapeHtml(result.summary || "已生成设计系统、页面视觉方案和效果图预览。")}</p>
        <div class="prototype-meta">
          ${result.style_label ? `<span>视觉风格：${escapeHtml(result.style_label)}</span>` : ""}
          ${tokens.accent ? `<span>主色：${escapeHtml(tokens.accent)}</span>` : ""}
          ${components.slice(0, 5).map((item) => `<span>${escapeHtml(item.name || item)}</span>`).join("")}
        </div>
      </div>
      <div class="prototype-actions">
        <a class="export" href="${escapeHtml(result.preview_url)}" target="_blank">打开效果图</a>
        <a class="secondary link-button" href="${escapeHtml(result.preview_url)}?embed=1" target="_blank">演示视图</a>
      </div>
      <iframe src="${escapeHtml(result.preview_url)}?embed=1" title="UI 设计师效果图预览"></iframe>
    </section>
  `;
}

renderWorkflow = function renderWorkflowWithPrototype(workflow) {
  renderWorkflowBase(workflow);
  deliveryExportVersions = Array.isArray(workflow.delivery_exports) ? workflow.delivery_exports : [];
  renderDeliveryExportPanel();
  loadDeliveryExportVersions().catch(() => {});
};

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/health");
    if (!response.ok) return;
    runtimeConfig = await response.json();
    renderRuntimeStatus();
  } catch {
    runtimeConfig = null;
  }
}

async function refreshLatestWorkflow() {
  const response = await fetch("/api/workflows/latest");
  if (!response.ok) return;
  renderWorkflow(await response.json());
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusTimer = setInterval(async () => {
    try {
      const response = await fetch("/api/workflows/status");
      if (!response.ok) return;
      const status = await response.json();
      renderRuntimeStatus(status);

      if (!status.running && latestWorkflow && status.workflow_id === latestWorkflow.workflow_id) {
        await refreshLatestWorkflow();
        stopStatusPolling();
      }
    } catch {
      // Polling is best-effort; the generated rule result remains visible.
    }
  }, 2500);
}

async function createIssues(provider) {
  const button = provider === "github" ? githubButton : jiraButton;
  if (!button) return;
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再创建 issues。";
    return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = "创建中...";
  integrationStatus.textContent = "";

  try {
    const response = await fetch(`/api/integrations/${provider}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 20 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "创建失败");
    const links = data.created
      .map((item) => `<a href="${item.url}" target="_blank">${item.jira_key || `#${item.number}`}</a>`)
      .join("、");
    integrationStatus.innerHTML = `已创建 ${data.created.length} 条 ${
      provider === "github" ? "GitHub" : "Jira"
    } issues：${links}`;
  } catch (error) {
    integrationStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function generateProductPrototype(triggerButton = prototypeButton) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再生成产品原型。";
    return;
  }

  const original = triggerButton?.textContent || "";
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "生成中...";
  }
  latestPrototype = { loading: true };
  integrationStatus.textContent = "产品经理 Agent 正在生成产品原型...";
  renderPrototypePanel();

  try {
    const response = await fetch("/api/prototypes/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: latestWorkflow.workflow_id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "产品原型生成失败");
    latestPrototype = data;
    integrationStatus.textContent = "产品原型已生成，可在下方预览或新窗口打开。";
  } catch (error) {
    latestPrototype = { error: error.message };
    integrationStatus.textContent = error.message;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = original;
    }
    renderPrototypePanel();
  }
}

function getEmployeeById(id) {
  return (latestWorkflow?.agent_employees || []).find((employee) => employee.id === id);
}

function requirementOutputs() {
  return getEmployeeById("requirements-analyst")?.outputs || [];
}

async function runEmployeeRoleAgent(roleId, actionId, extra = {}, options = {}) {
  const response = await fetch("/api/roles/run-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_id: roleId, action_id: actionId, extra, ...options }),
  });
  return readJsonResponse(response, "岗位 Agent 生成失败");
}

function markEmployeeOutputsConfirmed(roleId) {
  const employee = getEmployeeById(roleId);
  (employee?.outputs || []).forEach((item, index) => {
    const key = `${employee.id}:${item.stage_id || "planned"}:${item.title || index}`;
    agentArtifactState[key] = { ...getArtifactStateForGlobal(key), status: "confirmed" };
  });
}

async function generateCurrentRole(roleId) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再生成岗位产物。";
    return;
  }
  if (!isRoleUnlocked(roleId)) {
    integrationStatus.textContent = "请先确认上游岗位产物，再生成当前岗位产物。";
    return;
  }
  if (isRoleGenerated(roleId)) {
    integrationStatus.textContent = "当前岗位产物已生成，请确认后再进入下游岗位。";
    return;
  }
  const previousRoleId = roleFlowOrder[roleFlowIndex(roleId) - 1] || "";
  const previousEmployee = previousRoleId ? getEmployeeById(previousRoleId) : null;
  const result = await runEmployeeRoleAgent(roleId, roleGenerationActionId, {
    previous_role_id: previousRoleId,
    previous_outputs: previousEmployee?.outputs || [],
  });
  applyRoleAgentWorkflowResult({ ...result, generated_role_id: roleId, next_role_id: roleId });
  integrationStatus.textContent = result.summary || `${getEmployeeById(roleId)?.title || "当前岗位"}产物已生成，请在卡片内确认后再进入下游岗位。`;
}

function setRequirementActionResult(result) {
  requirementActionResult = result;
  renderAgentEmployees(latestWorkflow?.agent_employees || []);
  integrationStatus.textContent = result.summary;
}

async function runRequirementAnalysisAction(actionId) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再操作需求分析师卡片。";
    return;
  }

  const outputs = requirementOutputs();
  if (actionId === "generate-requirement-analysis-report") {
    const llmResult = await runEmployeeRoleAgent("requirements-analyst", actionId, { outputs });
    applyRoleAgentWorkflowResult(llmResult);
    setRequirementActionResult({
      ...llmResult,
      title: "需求分析报告已生成",
      summary: llmResult.summary || "已基于当前需求分析师产物汇总需求基线。",
      items: llmResult.items?.length ? llmResult.items : [
        `已汇总 ${outputs.length || 0} 个上游产物。`,
        "报告覆盖业务目标、用户角色、范围边界、约束风险和待确认事项。",
        "下一步建议先确认高风险约束，再交接产品经理生成需求文档。",
      ],
    });
    return;
  }

  if (actionId === "generate-clarification-questions") {
    const llmResult = await runEmployeeRoleAgent("requirements-analyst", actionId, { outputs });
    applyRoleAgentWorkflowResult(llmResult);
    setRequirementActionResult({
      ...llmResult,
      title: "待确认问题已生成",
      summary: llmResult.summary || "已生成进入产品设计前建议确认的问题清单。",
      items: llmResult.items?.length ? llmResult.items : [
        "业务目标是否有明确量化指标或验收口径？",
        "各用户角色的权限边界、审批责任和异常处理是否已确认？",
        "本期范围外的能力是否已得到客户认可？",
        "隐私、审计、集成、部署和交付周期约束是否有负责人确认？",
      ],
    });
    return;
  }

  if (actionId === "handoff-requirement-baseline") {
    markEmployeeOutputsConfirmed("requirements-analyst");
    requirementActionResult = {
      title: "需求基线已确认并交接产品经理",
      summary: "需求分析师产物已标记确认，产品经理现在处于待生成状态。",
      items: ["需求基线状态：已确认", "下游岗位：产品经理", "建议动作：进入产品经理卡片，点击生成产品经理产物。"],
    };
    confirmRoleAndAdvance("requirements-analyst", "需求基线已确认，产品经理已解锁为待生成。");
  }
}

function getArtifactStateForGlobal(key) {
  return agentArtifactState[key] || { expanded: false, status: "pending" };
}

function getUiStylePrompt() {
  return document.getElementById("uiStylePromptInput")?.value?.trim() || businessUiStyleSelect?.value || "enterprise-saas";
}

async function runWithActionProgress(button, label, task) {
  const original = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "生成中...";
  }
  integrationStatus.textContent = `${label} 正在调用 LLM Agent...`;
  try {
    return await task();
  } catch (error) {
    integrationStatus.textContent = `${label} 失败：${error.message}`;
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function handoffUiDesignToDeveloper() {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再交接 UI 设计稿。";
    return;
  }
  markEmployeeOutputsConfirmed("ui-designer");
  uiDesignerActionResult = {
    title: "UI 设计稿已确认并交接开发人员",
    summary: "UI 设计师产物已标记确认，架构师现在处于待生成状态。",
    items: ["设计状态：已确认", "下游岗位：架构师", "建议动作：进入架构师卡片，点击生成架构师产物。"],
  };
  confirmRoleAndAdvance("ui-designer", "UI 设计稿已确认，架构师已解锁为待生成。");
}

async function handoffProductBaseline() {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再确认产品产物。";
    return;
  }
  markEmployeeOutputsConfirmed("product-manager");
  confirmRoleAndAdvance("product-manager", "产品产物已确认，UI 设计师已解锁为待生成。");
}

async function confirmCurrentRole(roleId) {
  const employee = getEmployeeById(roleId);
  markEmployeeOutputsConfirmed(roleId);
  const next = roleFlowOrder[roleFlowIndex(roleId) + 1];
  const nextEmployee = next ? getEmployeeById(next) : null;
  confirmRoleAndAdvance(roleId, next ? `${employee?.title || "当前岗位"}产物已确认，${nextEmployee?.title || "下游岗位"}已解锁为待生成。` : "测试产物已确认，本轮流程已完成。");
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || fallbackMessage };
  }
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

async function generateBusinessUiBoards(triggerButton = businessUiButton) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再生成业务 UI 图。";
    return;
  }

  const original = triggerButton?.textContent || "";
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "生成中...";
  }
  latestBusinessUi = { loading: true };
  integrationStatus.textContent = "UI 设计师 Agent 正在生成业务 UI 图...";
  renderBusinessUiPanel();

  try {
    const uiStyle = getUiStylePrompt();
    const response = await fetch("/api/business-ui/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: latestWorkflow.workflow_id, ui_style: uiStyle }),
    });
    const data = await readJsonResponse(response, "业务 UI 图生成失败");
    latestBusinessUi = data;
    integrationStatus.textContent = `业务 UI 图已按「${uiStyle}」生成，可在下方预览或新窗口打开。`;
  } catch (error) {
    latestBusinessUi = { error: error.message };
    integrationStatus.textContent = error.message;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = original;
    }
    renderBusinessUiPanel();
  }
}

async function generateUiDesignerConcept(triggerButton = uiDesignerButton) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行 AI 工作流，再让 UI 设计师 Agent 生成效果图。";
    return;
  }

  const original = triggerButton?.textContent || "";
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = "设计中...";
  }
  latestUiDesigner = { loading: true };
  integrationStatus.textContent = "UI 设计师 Agent 正在生成视觉设计方案...";
  renderUiDesignerPanel();

  try {
    const uiStyle = getUiStylePrompt();
    const response = await fetch("/api/ui-designer/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: latestWorkflow.workflow_id, ui_style: uiStyle }),
    });
    const data = await readJsonResponse(response, "UI 设计师 Agent 生成失败");
    latestUiDesigner = data;
    integrationStatus.textContent = `UI 设计师 Agent 已按「${uiStyle}」生成视觉设计方案和效果图。`;
  } catch (error) {
    latestUiDesigner = { error: error.message };
    integrationStatus.textContent = error.message;
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = original;
    }
    renderUiDesignerPanel();
  }
}

async function generateImplementationPlan(issueKey) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再生成实施方案。";
    return;
  }

  implementationPlans[issueKey] = { loading: true };
  renderBacklog(latestWorkflow.backlog_issues || []);

  try {
    const response = await fetch("/api/implementation/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_key: issueKey }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成实施方案失败");
    implementationPlans[issueKey] = { plan: data.plan };
  } catch (error) {
    implementationPlans[issueKey] = { error: error.message };
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

async function generatePatchDraft(issueKey) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再生成 patch 草案。";
    return;
  }

  patchDrafts[issueKey] = { loading: true };
  renderBacklog(latestWorkflow.backlog_issues || []);

  try {
    const response = await fetch("/api/implementation/patch-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issue_key: issueKey,
        implementation_plan: implementationPlans[issueKey]?.plan || null,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成 patch 草案失败");
    patchDrafts[issueKey] = { patch: data.patch };
  } catch (error) {
    patchDrafts[issueKey] = { error: error.message };
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

async function generateCodeDraft(issueKey) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再生成代码。";
    return;
  }

  implementationPlans[issueKey] = { loading: true };
  patchDrafts[issueKey] = { loading: true };
  renderBacklog(latestWorkflow.backlog_issues || []);

  try {
    const response = await fetch("/api/implementation/generate-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_key: issueKey }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI 生成代码失败");
    implementationPlans[issueKey] = { plan: data.plan };
    patchDrafts[issueKey] = { patch: data.patch };
    integrationStatus.textContent = "AI 已生成实施方案和 Patch 草案，请审查后再应用。";
  } catch (error) {
    implementationPlans[issueKey] = { error: error.message };
    patchDrafts[issueKey] = { error: error.message };
    integrationStatus.textContent = error.message;
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

async function applyPatchDraft(issueKey) {
  const state = patchDrafts[issueKey];
  if (state?.patch && !isPatchValidated(state.patch, state.validation || {})) {
    integrationStatus.textContent = "请先完成前端验证清单，确认生成的业务代码可接受后再应用 Patch。";
    return;
  }
  if (!state?.patch) {
    integrationStatus.textContent = "请先生成 patch 草案。";
    return;
  }
  const confirmed = window.confirm("确认将这个 patch 草案应用到本地工作区？操作不会提交 Git，但会修改文件。");
  if (!confirmed) return;

  try {
    const response = await fetch("/api/implementation/apply-patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: state.patch }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "应用 patch 失败");
    patchDrafts[issueKey] = { ...state, applyResult: data };
    integrationStatus.textContent = data.message || "Patch 已应用到本地工作区。";
  } catch (error) {
    patchDrafts[issueKey] = { ...state, error: error.message };
    integrationStatus.textContent = error.message;
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

async function generateUiPreview(issueKey) {
  const state = patchDrafts[issueKey];
  if (!state?.patch) {
    integrationStatus.textContent = "请先生成 Patch 草案。";
    return;
  }
  patchDrafts[issueKey] = {
    ...state,
    validation: {
      ...(state.validation || {}),
      ui_preview: { loading: true },
    },
  };
  renderBacklog(latestWorkflow.backlog_issues || []);

  try {
    const response = await fetch("/api/implementation/ui-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: state.patch }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成 UI 预览失败");
    patchDrafts[issueKey] = {
      ...patchDrafts[issueKey],
      validation: {
        ...(patchDrafts[issueKey]?.validation || {}),
        ui_preview: data,
      },
    };
    integrationStatus.textContent = "UI 预览已生成，请在预览框中检查功能和视觉效果。";
  } catch (error) {
    patchDrafts[issueKey] = {
      ...patchDrafts[issueKey],
      validation: {
        ...(patchDrafts[issueKey]?.validation || {}),
        ui_preview: { error: error.message },
      },
    };
    integrationStatus.textContent = error.message;
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

async function generateModuleUiPreview(issueKey) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再生成模块 UI 预览。";
    return;
  }

  if (!patchDrafts[issueKey]?.patch) {
    integrationStatus.textContent = "正在为该模块生成前端代码和 Patch 草案...";
    await generateCodeDraft(issueKey);
  }

  if (!patchDrafts[issueKey]?.patch) {
    const message = patchDrafts[issueKey]?.error || "未生成可预览的 Patch 草案。";
    patchDrafts[issueKey] = {
      ...(patchDrafts[issueKey] || {}),
      validation: {
        ...(patchDrafts[issueKey]?.validation || {}),
        ui_preview: { error: message },
      },
    };
    integrationStatus.textContent = message;
    renderBacklog(latestWorkflow.backlog_issues || []);
    return;
  }

  await generateUiPreview(issueKey);
}

generateModuleUiPreview = async function generateModuleUiPreviewWithRetry(issueKey) {
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再生成模块 UI 预览。";
    return;
  }

  if (!patchDrafts[issueKey]?.patch) {
    integrationStatus.textContent = "正在为该模块生成前端代码和 Patch 草案...";
    await generateCodeDraft(issueKey);
  }

  if (!patchDrafts[issueKey]?.patch) {
    const message = patchDrafts[issueKey]?.error || "未生成可预览的 Patch 草案。";
    patchDrafts[issueKey] = {
      ...(patchDrafts[issueKey] || {}),
      validation: {
        ...(patchDrafts[issueKey]?.validation || {}),
        ui_preview: { error: message },
      },
    };
    integrationStatus.textContent = message;
    renderBacklog(latestWorkflow.backlog_issues || []);
    return;
  }

  await generateUiPreview(issueKey);

  const previewError = patchDrafts[issueKey]?.validation?.ui_preview?.error || "";
  if (/patch does not apply|hunk|corrupt patch|No valid patches/i.test(previewError)) {
    integrationStatus.textContent = "旧 Patch 无法预览，正在重新生成 Patch 草案...";
    patchDrafts[issueKey] = { loading: true };
    renderBacklog(latestWorkflow.backlog_issues || []);
    await generateCodeDraft(issueKey);
    if (patchDrafts[issueKey]?.patch) await generateUiPreview(issueKey);
  }
};

async function revertPatchDraft(issueKey) {
  const state = patchDrafts[issueKey];
  if (!state?.patch || !state?.applyResult) {
    integrationStatus.textContent = "没有可撤销的已应用 patch。";
    return;
  }
  const confirmed = window.confirm("确认撤销本次 patch？这会反向应用草案 diff。");
  if (!confirmed) return;

  try {
    const response = await fetch("/api/implementation/revert-patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: state.patch }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "撤销 patch 失败");
    patchDrafts[issueKey] = {
      ...state,
      applyResult: { ...state.applyResult, revertResult: data },
    };
    integrationStatus.textContent = data.message || "Patch 已撤销。";
  } catch (error) {
    patchDrafts[issueKey] = { ...state, error: error.message };
    integrationStatus.textContent = error.message;
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

async function generateCommitDraft(issueKey) {
  const state = patchDrafts[issueKey];
  if (!state?.patch || !state?.applyResult) {
    integrationStatus.textContent = "请先应用 patch，再生成提交说明。";
    return;
  }

  try {
    const response = await fetch("/api/implementation/commit-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patch: state.patch,
        apply_result: state.applyResult,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成提交说明失败");
    patchDrafts[issueKey] = {
      ...state,
      applyResult: { ...state.applyResult, commitDraft: data },
    };
    integrationStatus.textContent = "提交说明草稿已生成。";
  } catch (error) {
    patchDrafts[issueKey] = { ...state, error: error.message };
    integrationStatus.textContent = error.message;
  }

  renderBacklog(latestWorkflow.backlog_issues || []);
}

function renderProjects() {
  if (!projectList) return;
  const term = projectSearchTerm.trim().toLowerCase();
  const projects = (projectsState.projects || []).filter((project) => {
    if (!term) return true;
    return [project.name, project.client_name, project.industry]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  if (!projects.length) {
    projectList.innerHTML = `<div class="project-empty">${term ? "没有匹配的项目。" : "暂无项目，先创建一个项目。"}</div>`;
    return;
  }

  projectList.innerHTML = projects
    .map((project) => {
      const active = project.id === projectsState.active_project_id;
      const latest = project.latest_workflow_at
        ? new Date(project.latest_workflow_at).toLocaleString("zh-CN")
        : "尚未运行工作流";
      return `
        <button type="button" class="project-card ${active ? "active" : ""}" data-project-id="${escapeHtml(project.id)}">
          <span>
            <strong>${escapeHtml(project.name || "未命名项目")}</strong>
            <small>${escapeHtml([project.client_name, project.industry].filter(Boolean).join(" / ") || "未填写客户信息")}</small>
            <small>${escapeHtml(latest)}</small>
          </span>
          <em>${escapeHtml(project.workflow_count || 0)} 次工作流</em>
        </button>
      `;
    })
    .join("");
}

function syncActiveProjectToForm(project) {
  if (!project) return;
  projectIdInput.value = project.id;
  if (activeProjectLine) {
    activeProjectLine.textContent = `${project.name || "未命名项目"}${project.client_name ? ` / ${project.client_name}` : ""}`;
  }
  const projectNameInput = form.elements.project_name;
  const clientInput = form.elements.client_name;
  const industryInput = form.elements.industry;
  if (projectNameInput && project.name) projectNameInput.value = project.name;
  if (clientInput) clientInput.value = project.client_name || "";
  if (industryInput) industryInput.value = project.industry || "";
}

async function createProject(event) {
  event.preventDefault();
  const button = projectForm.querySelector("button");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "创建中...";

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToJson(projectForm)),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "创建项目失败");
    projectsState = { active_project_id: data.active_project_id, projects: data.projects };
    projectForm.reset();
    renderProjects();
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function selectProject(projectId) {
  const response = await fetch("/api/projects/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || "切换项目失败");
    return;
  }

  projectsState.active_project_id = data.active_project_id;
  syncActiveProjectToForm(data.project);
  renderProjects();
  showView("workflow");
  implementationPlans = {};
  patchDrafts = {};
  integrationStatus.textContent = "";

  if (data.latest_workflow) {
    renderWorkflow(data.latest_workflow);
    return;
  }

  latestWorkflow = null;
  projectTitle.textContent = data.project.name || "等待生成";
  modeLine.textContent = "当前项目尚未运行工作流";
  metrics.innerHTML = "";
  renderAgentEmployees([]);
  if (backlog) backlog.innerHTML = "";
  if (timeline) timeline.innerHTML = `
    <div class="empty">
      <h3>当前项目尚未生成工作流</h3>
      <p>填写左侧项目需求并运行 AI 工作流，即可生成交付包和 Backlog。</p>
    </div>
  `;
}

backlog?.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-select-page-key]");
  if (pageButton) {
    selectedPageIssueKey = pageButton.dataset.selectPageKey;
    renderBacklog(latestWorkflow?.backlog_issues || []);
    return;
  }
  const validationInput = event.target.closest("[data-validation-key]");
  if (validationInput) {
    const issueKey = validationInput.dataset.validationKey;
    const itemKey = validationInput.dataset.validationItem;
    const state = patchDrafts[issueKey];
    patchDrafts[issueKey] = {
      ...state,
      validation: {
        ...(state?.validation || {}),
        [itemKey]: validationInput.checked,
      },
    };
    renderBacklog(latestWorkflow.backlog_issues || []);
    return;
  }
  const codeButton = event.target.closest("[data-code-key]");
  if (codeButton) {
    generateCodeDraft(codeButton.dataset.codeKey);
    return;
  }
  const planButton = event.target.closest("[data-issue-key]");
  if (planButton) {
    generateImplementationPlan(planButton.dataset.issueKey);
    return;
  }
  const patchButton = event.target.closest("[data-patch-key]");
  if (patchButton) {
    generatePatchDraft(patchButton.dataset.patchKey);
    return;
  }
  const modulePreviewButton = event.target.closest("[data-module-preview-key]");
  if (modulePreviewButton) {
    generateModuleUiPreview(modulePreviewButton.dataset.modulePreviewKey);
    return;
  }
  const previewButton = event.target.closest("[data-preview-key]");
  if (previewButton) {
    generateUiPreview(previewButton.dataset.previewKey);
    return;
  }
  const applyButton = event.target.closest("[data-apply-key]");
  if (applyButton) {
    applyPatchDraft(applyButton.dataset.applyKey);
    return;
  }
  const revertButton = event.target.closest("[data-revert-key]");
  if (revertButton) {
    revertPatchDraft(revertButton.dataset.revertKey);
    return;
  }
  const commitButton = event.target.closest("[data-commit-key]");
  if (commitButton) {
    generateCommitDraft(commitButton.dataset.commitKey);
  }
});

agentEmployeeBoard?.addEventListener("click", (event) => {
  const artifactToggle = event.target.closest("[data-artifact-toggle]");
  if (artifactToggle) {
    const key = artifactToggle.dataset.artifactToggle;
    const state = getArtifactStateForGlobal(key);
    agentArtifactState[key] = { ...state, expanded: !state.expanded };
    renderAgentEmployees(latestWorkflow?.agent_employees || []);
    return;
  }
  const artifactStatusButton = event.target.closest("[data-artifact-status]");
  if (artifactStatusButton) {
    const key = artifactStatusButton.dataset.artifactStatus;
    const state = getArtifactStateForGlobal(key);
    agentArtifactState[key] = { ...state, status: artifactStatusButton.dataset.statusValue || "pending", expanded: true };
    renderAgentEmployees(latestWorkflow?.agent_employees || []);
    return;
  }
  const actionButton = event.target.closest("[data-agent-action]");
  if (actionButton) {
    const actionId = actionButton.dataset.agentAction;
    if (actionId === roleGenerationActionId) runWithActionProgress(actionButton, "岗位产物生成", () => generateCurrentRole(selectedAgentEmployeeId)).catch(() => {});
    if (actionId === "generate-product-prototype") generateProductPrototype(actionButton);
    if (actionId === "handoff-product-baseline") runWithActionProgress(actionButton, "产品经理交接", handoffProductBaseline).catch(() => {});
    if (actionId === "generate-business-ui") generateBusinessUiBoards(actionButton);
    if (actionId === "generate-ui-designer-concept") generateUiDesignerConcept(actionButton);
    if (actionId === "handoff-ui-design") runWithActionProgress(actionButton, "UI 设计师交接", handoffUiDesignToDeveloper).catch(() => {});
    if (actionId === "confirm-current-role") runWithActionProgress(actionButton, "岗位确认", () => confirmCurrentRole(selectedAgentEmployeeId)).catch(() => {});
    if (
      actionId === "generate-requirement-analysis-report" ||
      actionId === "generate-clarification-questions" ||
      actionId === "handoff-requirement-baseline"
    ) {
      runWithActionProgress(actionButton, "需求分析师", () => runRequirementAnalysisAction(actionId)).catch(() => {});
    }
    return;
  }
  const backButton = event.target.closest("[data-agent-back]");
  if (backButton) {
    selectedAgentEmployeeId = "";
    renderAgentEmployees(latestWorkflow?.agent_employees || []);
    return;
  }
  const detailButton = event.target.closest("[data-agent-detail-id]");
  if (!detailButton) return;
  selectedAgentEmployeeId = detailButton.dataset.agentDetailId || "";
  renderAgentEmployees(latestWorkflow?.agent_employees || []);
});

projectForm.addEventListener("submit", createProject);
refreshProjectsButton.addEventListener("click", loadProjects);
projectSearchInput?.addEventListener("input", (event) => {
  projectSearchTerm = event.target.value || "";
  renderProjects();
});
projectList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-project-id]");
  if (!card) return;
  selectProject(card.dataset.projectId);
});

loginForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem("aiWorkflowLoggedIn", "true");
  showView("projects");
  loadProjects();
});

logoutButton?.addEventListener("click", () => {
  localStorage.removeItem("aiWorkflowLoggedIn");
  stopStatusPolling();
  showView("auth");
});

backToProjectsButton?.addEventListener("click", () => {
  stopStatusPolling();
  showView("projects");
  loadProjects();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopStatusPolling();
  runButton.disabled = true;
  runButton.textContent = "正在生成...";
  integrationStatus.textContent = "LLM Agent 正在生成，请稍候...";
  renderRuntimeStatus({
    running: true,
    current_agent: "提交请求中",
    completed_agents: [],
    started_at: new Date().toISOString(),
    error: "",
  });
  startStatusPolling();

  try {
    const response = await fetch("/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToJson(form)),
    });

    const workflow = await readJsonResponse(response, `请求失败：${response.status}`);

    renderWorkflow(workflow);

    integrationStatus.textContent = "需求分析师 Agent 已生成，请确认后再生成产品经理产物。";
    await refreshLatestWorkflow().catch(() => {});
    stopStatusPolling();
    renderRuntimeStatus({
      running: false,
      current_agent: "完成",
      completed_agents: agentOrder,
      finished_at: new Date().toISOString(),
      error: "",
      workflow_id: workflow.workflow_id,
    });
  } catch (error) {
    integrationStatus.textContent = error.message;
    stopStatusPolling();
    renderRuntimeStatus({
      running: false,
      current_agent: "失败",
      completed_agents: [],
      finished_at: new Date().toISOString(),
      error: error.message,
    });
  } finally {
    runButton.disabled = false;
    runButton.textContent = "运行 AI 工作流";
  }
});

githubButton?.addEventListener("click", () => createIssues("github"));
jiraButton?.addEventListener("click", () => createIssues("jira"));
prototypeButton?.addEventListener("click", generateProductPrototype);
uiDesignerButton?.addEventListener("click", generateUiDesignerConcept);
businessUiButton?.addEventListener("click", generateBusinessUiBoards);
exportMarkdownButton?.addEventListener("click", () => exportDeliveryPackage("markdown", exportMarkdownButton));
exportHtmlButton?.addEventListener("click", () => exportDeliveryPackage("html", exportHtmlButton));
requireLoginView();
loadRuntimeConfig();
if (isLoggedIn()) loadProjects();
