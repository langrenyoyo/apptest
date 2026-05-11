const assert = require("assert");
const { spawn } = require("child_process");

const port = 8911;
const baseUrl = `http://127.0.0.1:${port}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Server did not become ready");
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer();

    const viewerLogin = await jsonRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "viewer", password: "demo", member_identity: "viewer" }),
    });
    assert.equal(viewerLogin.response.status, 200);
    const viewerCookie = cookieFrom(viewerLogin.response);
    assert.ok(viewerCookie, "viewer login should set a session cookie");

    const denied = await jsonRequest("/api/projects", {
      method: "POST",
      headers: { Cookie: viewerCookie },
      body: JSON.stringify({ project_name: "权限测试项目", goal: "验证只读成员不能创建项目。" }),
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.required_permission, "project:create");

    const managerLogin = await jsonRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "manager", password: "demo", member_identity: "delivery_manager" }),
    });
    const managerCookie = cookieFrom(managerLogin.response);
    assert.ok(managerCookie, "manager login should set a session cookie");

    const workflow = await jsonRequest("/api/workflows/run", {
      method: "POST",
      headers: { Cookie: managerCookie },
      body: JSON.stringify({
        project_name: "AI 合同审查门户",
        client_name: "某法律服务公司",
        industry: "法律科技",
        goal: "建设一个安全的 Web 应用，用于合同上传、知识库问答、风险条款识别和人工审批。",
        source_material: "需要登录、角色权限、RAG 检索、文件上传、PDF 导出和审计日志。",
        constraints: "需要隐私保护和人工审批。",
        target_users: "律师、律师助理、管理员",
        tech_stack: "Node.js、HTML、CSS、JavaScript",
      }),
    });
    assert.equal(workflow.response.status, 200, workflow.body.error || JSON.stringify(workflow.body));
    assert.ok(workflow.body.workflow_id);

    const exported = await fetch(`${baseUrl}/api/delivery-package/export?format=markdown`, {
      headers: { Cookie: managerCookie },
    });
    assert.equal(exported.status, 200);

    const versions = await jsonRequest("/api/delivery-package/versions", {
      headers: { Cookie: managerCookie },
    });
    assert.equal(versions.response.status, 200);
    assert.ok(versions.body.exports?.[0]?.readonly_url, "export should expose a readonly review link");
    const readonlyToken = new URL(versions.body.exports[0].readonly_url).searchParams.get("token");

    const readonlySubmit = await jsonRequest("/api/delivery-package/status", {
      method: "POST",
      body: JSON.stringify({
        token: readonlyToken,
        status: "confirmed",
        customer_feedback: "只读链接不应允许提交。",
      }),
    });
    assert.equal(readonlySubmit.response.status, 400);
    assert.match(readonlySubmit.body.error, /只读|read/i);

    console.log("api-smoke.test.js passed");
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
