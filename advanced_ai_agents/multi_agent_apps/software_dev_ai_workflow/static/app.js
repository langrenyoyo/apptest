const form = document.getElementById("workflowForm");
const runButton = document.getElementById("runButton");
const timeline = document.getElementById("timeline");
const metrics = document.getElementById("metrics");
const projectTitle = document.getElementById("projectTitle");
const modeLine = document.getElementById("modeLine");
const backlog = document.getElementById("backlog");
const integrationStatus = document.getElementById("integrationStatus");
const runtimeStatus = document.getElementById("runtimeStatus");
const githubButton = document.getElementById("githubButton");
const jiraButton = document.getElementById("jiraButton");
const projectForm = document.getElementById("projectForm");
const projectList = document.getElementById("projectList");
const projectIdInput = document.getElementById("projectIdInput");
const refreshProjectsButton = document.getElementById("refreshProjectsButton");

let latestWorkflow = null;
let statusTimer = null;
let runtimeConfig = null;
let implementationPlans = {};
let patchDrafts = {};
let projectsState = { active_project_id: "default", projects: [] };

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
    deterministic: "规则引擎生成",
    deterministic_pending: "规则结果已返回，AI 后台优化中",
    deterministic_fallback: "AI 失败后保留规则结果",
  };
  return labels[mode] || mode || "未知模式";
}

function renderMetrics(values = {}) {
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
    backlog.innerHTML = "";
    timeline.innerHTML = `
      <div class="empty">
        <h3>当前项目尚未生成工作流</h3>
        <p>填写左侧项目信息并运行 AI 工作流，即可生成交付包和 Backlog。</p>
      </div>
    `;
    integrationStatus.textContent = `已切换到项目：${data.project.name}`;
  }
}

function renderBacklog(issues = []) {
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
  const mode = runtimeConfig.llm_enabled ? "真实 Agent 已启用" : "规则引擎模式";
  const source = runtimeConfig.ai_config_source || "env";
  const model = runtimeConfig.openai_model || "未配置模型";
  return `${mode} / ${source} / ${model}`;
}

function renderRuntimeStatus(status = null) {
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
    ? `后台优化失败，已保留规则结果：${status.error}`
    : running
      ? `AI 正在后台优化：${current || "准备中"}`
      : finished
        ? "AI 后台优化已完成"
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

function renderWorkflow(workflow) {
  latestWorkflow = workflow;
  projectTitle.textContent = workflow.project_name || "未命名项目";
  modeLine.textContent = `${modeLabel(workflow.generation_mode)}${workflow.model ? ` / ${workflow.model}` : ""}`;
  integrationStatus.textContent = workflow.generation_error
    ? `AI 生成失败，已保留规则结果：${workflow.generation_error}`
    : "";
  renderMetrics(workflow.metrics);
  backlog.innerHTML = renderModuleBacklog(workflow.backlog_issues || []);
  renderStages(workflow.stages);
}

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
  if (!latestWorkflow) {
    integrationStatus.textContent = "请先运行工作流，再创建 issues。";
    return;
  }

  const button = provider === "github" ? githubButton : jiraButton;
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

backlog.addEventListener("click", (event) => {
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

projectForm.addEventListener("submit", createProject);
refreshProjectsButton.addEventListener("click", loadProjects);
projectList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-project-id]");
  if (!card) return;
  selectProject(card.dataset.projectId);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopStatusPolling();
  runButton.disabled = true;
  runButton.textContent = "正在生成...";
  integrationStatus.textContent = "";

  renderRuntimeStatus({
    running: true,
    current_agent: "准备启动 Agent 团队",
    completed_agents: [],
  });

  try {
    const response = await fetch("/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToJson(form)),
    });

    if (!response.ok) throw new Error(`请求失败：${response.status}`);

    const workflow = await response.json();
    renderWorkflow(workflow);

    if (workflow.generation_mode === "deterministic_pending") {
      integrationStatus.textContent = "已先返回规则引擎结果，真实 Agent 正在后台优化。";
      renderRuntimeStatus({
        running: true,
        current_agent: "准备启动 Agent 团队",
        completed_agents: [],
        workflow_id: workflow.workflow_id,
      });
      startStatusPolling();
    } else {
      renderRuntimeStatus();
    }
  } catch (error) {
    timeline.innerHTML = `
      <div class="empty">
        <h3>工作流生成失败</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
    renderRuntimeStatus({
      running: false,
      error: error.message,
      completed_agents: [],
    });
  } finally {
    runButton.disabled = false;
    runButton.textContent = "运行 AI 工作流";
  }
});

githubButton.addEventListener("click", () => createIssues("github"));
jiraButton.addEventListener("click", () => createIssues("jira"));
loadRuntimeConfig();
loadProjects();
