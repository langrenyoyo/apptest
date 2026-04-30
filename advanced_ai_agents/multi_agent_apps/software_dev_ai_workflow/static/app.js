const form = document.getElementById("workflowForm");
const runButton = document.getElementById("runButton");
const timeline = document.getElementById("timeline");
const metrics = document.getElementById("metrics");
const projectTitle = document.getElementById("projectTitle");
const modeLine = document.getElementById("modeLine");
const backlog = document.getElementById("backlog");
const integrationStatus = document.getElementById("integrationStatus");
const githubButton = document.getElementById("githubButton");
const jiraButton = document.getElementById("jiraButton");
let latestWorkflow = null;
let statusTimer = null;

function formToJson(formElement) {
  const data = new FormData(formElement);
  return Object.fromEntries(data.entries());
}

function metricLabel(key) {
  const labels = {
    estimated_sprints: "预估迭代数",
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
    deterministic_pending: "规则引擎已生成，后台 AI 优化中",
    deterministic_fallback: "LLM 失败后回退到规则引擎",
  };
  return labels[mode] || mode || "未知模式";
}

function renderMetrics(values) {
  metrics.innerHTML = Object.entries(values)
    .map(([key, value]) => `
      <div class="metric">
        <strong>${value}</strong>
        <span>${metricLabel(key)}</span>
      </div>
    `)
    .join("");
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
      <div class="issue-list">
        ${issues
          .map((issue) => `
            <article class="issue">
              <strong>${issue.key}</strong>
              <span>${escapeHtml(issue.title)}</span>
            </article>
          `)
          .join("")}
      </div>
    </section>
  `;
}

function renderStages(stages) {
  timeline.innerHTML = stages
    .map((stage) => `
      <article class="stage">
        <div class="stage-head">
          <div>
            <h3>${stage.name}</h3>
            <p class="summary">${stage.summary}</p>
          </div>
          <div class="owner">${stage.owner}</div>
        </div>
        ${stage.artifacts
          .map((artifact) => `
            <div class="artifact">
              <h4>${artifact.title}</h4>
              <pre>${escapeHtml(artifact.content.trim())}</pre>
            </div>
          `)
          .join("")}
      </article>
    `)
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderRunningStatus(status) {
  const completed = status.completed_agents?.length
    ? `已完成：${status.completed_agents.map(escapeHtml).join("、")}`
    : "正在启动 Agent 团队";
  timeline.innerHTML = `
    <div class="empty">
      <h3>${escapeHtml(status.current_agent || "正在生成")}</h3>
      <p>${completed}</p>
    </div>
  `;
}

async function refreshLatestWorkflow() {
  const response = await fetch("/api/workflows/latest");
  if (!response.ok) return;
  const workflow = await response.json();
  latestWorkflow = workflow;
  projectTitle.textContent = workflow.project_name;
  modeLine.textContent = `${modeLabel(workflow.generation_mode)}${workflow.model ? ` · ${workflow.model}` : ""}`;
  integrationStatus.textContent = workflow.generation_error ? `LLM 生成失败，已保留规则结果：${workflow.generation_error}` : "";
  renderMetrics(workflow.metrics);
  renderBacklog(workflow.backlog_issues || []);
  renderStages(workflow.stages);
}

function startStatusPolling() {
  stopStatusPolling();
  statusTimer = setInterval(async () => {
    try {
      const response = await fetch("/api/workflows/status");
      if (!response.ok) return;
      const status = await response.json();
      if (status.running) {
        renderRunningStatus(status);
      } else if (latestWorkflow && status.workflow_id === latestWorkflow.workflow_id) {
        await refreshLatestWorkflow();
        stopStatusPolling();
      }
    } catch {
      // Status polling should never interrupt the main workflow request.
    }
  }, 1200);
}

function stopStatusPolling() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
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
    integrationStatus.innerHTML = `已创建 ${data.created.length} 条 ${provider === "github" ? "GitHub" : "Jira"} issues：${links}`;
  } catch (error) {
    integrationStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  runButton.disabled = true;
  runButton.textContent = "正在生成...";

  try {
    const response = await fetch("/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToJson(form)),
    });

    if (!response.ok) {
      throw new Error(`请求失败：${response.status}`);
    }

    const workflow = await response.json();
    latestWorkflow = workflow;
    projectTitle.textContent = workflow.project_name;
    modeLine.textContent = `${modeLabel(workflow.generation_mode)}${workflow.model ? ` · ${workflow.model}` : ""}`;
    integrationStatus.textContent = workflow.generation_error ? `LLM 生成失败，已自动回退：${workflow.generation_error}` : "";
    renderMetrics(workflow.metrics);
    renderBacklog(workflow.backlog_issues || []);
    renderStages(workflow.stages);
    if (workflow.generation_mode === "deterministic_pending") {
      integrationStatus.textContent = "已先返回规则引擎结果，AI Agent 正在后台优化。";
      startStatusPolling();
    }
  } catch (error) {
    timeline.innerHTML = `
      <div class="empty">
        <h3>工作流生成失败</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  } finally {
    runButton.disabled = false;
    runButton.textContent = "运行 AI 工作流";
  }
});

githubButton.addEventListener("click", () => createIssues("github"));
jiraButton.addEventListener("click", () => createIssues("jira"));
