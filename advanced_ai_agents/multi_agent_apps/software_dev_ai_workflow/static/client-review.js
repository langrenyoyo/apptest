const projectName = document.getElementById("projectName");
const projectSummary = document.getElementById("projectSummary");
const reviewStatus = document.getElementById("reviewStatus");
const packageTitle = document.getElementById("packageTitle");
const packageMeta = document.getElementById("packageMeta");
const customerFeedback = document.getElementById("customerFeedback");
const confirmButton = document.getElementById("confirmButton");
const needsUpdateButton = document.getElementById("needsUpdateButton");
const scopeList = document.getElementById("scopeList");
const downloadMarkdown = document.getElementById("downloadMarkdown");
const downloadHtml = document.getElementById("downloadHtml");

let latestWorkflow = null;
let currentExport = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status = "draft") {
  return (
    {
      draft: "草稿",
      pending_customer_confirmation: "待客户确认",
      confirmed: "已确认",
      needs_update: "需修改",
    }[status] || "草稿"
  );
}

function formatLocalDateTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

async function readJson(response, fallbackMessage) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || fallbackMessage };
  }
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

function renderEmpty(message) {
  projectName.textContent = "暂无可验收交付包";
  projectSummary.textContent = message;
  reviewStatus.innerHTML = `<strong>${escapeHtml(message)}</strong><span class="status-pill">等待交付</span>`;
  packageTitle.textContent = "尚未导出";
  packageMeta.innerHTML = "";
  scopeList.innerHTML = "";
  confirmButton.disabled = true;
  needsUpdateButton.disabled = true;
}

function renderReview() {
  if (!latestWorkflow) {
    renderEmpty("请先由交付团队生成工作流。");
    return;
  }

  const exports = latestWorkflow.delivery_exports || [];
  currentExport = exports[exports.length - 1] || null;
  projectName.textContent = latestWorkflow.project_name || "未命名项目";
  projectSummary.textContent = latestWorkflow.request?.goal || "请确认当前交付包是否满足本轮需求范围。";

  if (!currentExport) {
    renderEmpty("交付团队尚未导出交付包。");
    return;
  }

  const locked = Boolean(currentExport.frozen || currentExport.status === "confirmed");
  packageTitle.textContent = `v${currentExport.version} ${currentExport.label || "交付包"}`;
  customerFeedback.value = currentExport.customer_feedback || "";
  customerFeedback.disabled = locked;
  confirmButton.disabled = locked;
  needsUpdateButton.disabled = locked;
  downloadMarkdown.href = "/api/delivery-package/export?format=markdown";
  downloadHtml.href = "/api/delivery-package/export?format=html";

  reviewStatus.innerHTML = `
    <div>
      <strong>${locked ? "该版本已确认冻结" : "等待客户验收操作"}</strong>
      <p>${locked ? "如需继续修改，请联系交付团队导出新版本。" : "请下载交付包查看内容，填写反馈后确认通过或要求修改。"}</p>
    </div>
    <span class="status-pill ${escapeHtml(currentExport.status || "draft")}">${escapeHtml(statusLabel(currentExport.status))}</span>
  `;

  packageMeta.innerHTML = `
    <span><b>客户</b>${escapeHtml(latestWorkflow.client_name || "内部项目")}</span>
    <span><b>导出时间</b>${escapeHtml(formatLocalDateTime(currentExport.exported_at))}</span>
    <span><b>生成模式</b>${escapeHtml(latestWorkflow.generation_mode || "deterministic")}</span>
    <span><b>确认时间</b>${escapeHtml(currentExport.confirmed_at ? formatLocalDateTime(currentExport.confirmed_at) : "尚未确认")}</span>
  `;

  const issues = latestWorkflow.backlog_issues || [];
  const employees = latestWorkflow.agent_employees || [];
  scopeList.innerHTML = `
    <span><b>Agent 岗位</b>${escapeHtml(employees.length)} 个</span>
    <span><b>已生成产物</b>${escapeHtml(employees.filter((item) => (item.outputs || []).some((output) => output.content)).length)} 个岗位</span>
    <span><b>Backlog</b>${escapeHtml(issues.length)} 条任务</span>
    <span><b>客户变更</b>${escapeHtml(issues.filter((issue) => (issue.labels || []).includes("customer-change") || /^CR-/.test(issue.key || "")).length)} 条</span>
  `;
}

async function loadReview() {
  try {
    const response = await fetch("/api/workflows/latest");
    latestWorkflow = await readJson(response, "读取交付工作流失败");
    renderReview();
  } catch (error) {
    renderEmpty(error.message);
  }
}

async function updateStatus(status) {
  if (!currentExport) return;
  const button = status === "confirmed" ? confirmButton : needsUpdateButton;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "提交中...";
  try {
    const response = await fetch("/api/delivery-package/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        export_id: currentExport.id,
        status,
        customer_feedback: customerFeedback.value,
      }),
    });
    const data = await readJson(response, "提交验收结果失败");
    latestWorkflow = data.workflow || latestWorkflow;
    renderReview();
  } catch (error) {
    reviewStatus.innerHTML = `<strong>${escapeHtml(error.message)}</strong><span class="status-pill needs_update">提交失败</span>`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

confirmButton.addEventListener("click", () => updateStatus("confirmed"));
needsUpdateButton.addEventListener("click", () => updateStatus("needs_update"));
loadReview();
