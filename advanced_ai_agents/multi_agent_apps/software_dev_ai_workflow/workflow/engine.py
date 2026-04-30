from __future__ import annotations

import re
from textwrap import dedent

from .models import Artifact, StageResult, WorkflowRequest, WorkflowResponse, WorkflowStage


class WorkflowEngine:
    """软件开发公司 AI 工作流 MVP 引擎。

    当前实现是确定性的，方便无 API Key 运行。每个阶段都保留 Agent 化
    的输入/输出结构，后续可以逐步替换为真实 LLM Agent。
    """

    def run(self, request: WorkflowRequest) -> WorkflowResponse:
        signals = self._extract_signals(request)
        stages = [
            self._intake(request, signals),
            self._product(signals),
            self._architecture(request, signals),
            self._delivery(signals),
            self._quality(signals),
            self._handoff(),
        ]

        return WorkflowResponse(
            project_name=request.project_name,
            client_name=request.client_name,
            stages=stages,
            metrics={
                "estimated_sprints": signals["sprints"],
                "epics": len(signals["epics"]),
                "stories": len(signals["stories"]),
                "risks": len(signals["risks"]),
                "integrations": len(signals["integrations"]),
            },
            next_actions=[
                "与客户确认范围边界、验收标准和优先级。",
                "根据技术架构创建代码仓库、环境配置和 CI/CD 流水线。",
                "把 Backlog 产物转换为 Jira 或 GitHub Issues。",
                "围绕集成、权限、数据迁移和部署方式开展技术澄清会。",
            ],
        )

    def export_markdown(self, response: WorkflowResponse) -> str:
        metric_labels = {
            "estimated_sprints": "预估迭代数",
            "epics": "业务模块",
            "stories": "用户故事",
            "risks": "风险项",
            "integrations": "集成项",
        }
        parts = [
            f"# {response.project_name} AI 软件交付工作流",
            "",
            f"- 工作流 ID：`{response.workflow_id}`",
            f"- 客户：{response.client_name or '内部项目'}",
            f"- 生成时间：{response.created_at}",
            "",
            "## 指标",
            "",
        ]
        for key, value in response.metrics.items():
            parts.append(f"- {metric_labels.get(key, key)}：{value}")
        for stage in response.stages:
            parts.extend(["", f"## {stage.name}", "", stage.summary, ""])
            for artifact in stage.artifacts:
                parts.extend([f"### {artifact.title}", "", artifact.content.strip(), ""])
        parts.extend(["## 下一步", ""])
        parts.extend(f"- {item}" for item in response.next_actions)
        return "\n".join(parts).strip() + "\n"

    def _extract_signals(self, request: WorkflowRequest) -> dict:
        text = " ".join(
            [
                request.project_name,
                request.industry,
                request.goal,
                request.source_material,
                request.constraints,
                request.target_users,
                request.tech_stack,
            ]
        )
        lowered = text.lower()

        feature_hints = [
            ("账号、权限与组织角色", ["login", "auth", "permission", "role", "用户", "权限", "登录", "账号", "角色"]),
            ("知识库检索与 RAG 问答", ["rag", "knowledge", "search", "文档", "知识库", "检索", "问答", "合同"]),
            ("业务流程与审批自动化", ["workflow", "approval", "自动化", "审批", "流程", "流转", "审核"]),
            ("数据看板与经营报表", ["dashboard", "report", "analytics", "报表", "看板", "统计", "分析"]),
            ("文件上传、解析与处理", ["upload", "file", "pdf", "excel", "上传", "文件", "解析"]),
            ("AI 助手交互与任务编排", ["chat", "assistant", "agent", "ai", "助手", "智能体", "对话"]),
            ("外部系统集成", ["jira", "github", "crm", "erp", "api", "integration", "集成", "接口"]),
        ]
        epics = [name for name, keys in feature_hints if any(key in lowered for key in keys)]
        if not epics:
            epics = ["核心业务流程", "用户操作界面", "后台管理与运营配置"]

        integrations = sorted(
            set(re.findall(r"\b(GitHub|Jira|Slack|Notion|CRM|ERP|S3|OSS|Postgres|MySQL|Redis|Qdrant)\b", text, re.I))
        )
        risks = []
        if any(word in lowered for word in ["compliance", "合规", "privacy", "隐私", "medical", "医疗", "finance", "金融", "legal", "法律"]):
            risks.append("存在合规、隐私或行业监管要求，需要在需求阶段明确边界和审计策略。")
        if any(word in lowered for word in ["legacy", "migration", "旧系统", "迁移", "历史数据"]):
            risks.append("旧系统或历史数据迁移可能影响排期、数据质量和验收范围。")
        if any(word in lowered for word in ["real-time", "realtime", "实时", "voice", "video", "语音", "视频"]):
            risks.append("实时或多媒体能力需要额外做并发、延迟和容量压测。")
        risks.append("高影响决策不能完全自动化，AI 输出必须保留人工复核和责任归档。")

        stories = []
        for epic in epics:
            stories.append(f"作为业务用户，我可以使用「{epic}」，从而在一个工作台内完成关键任务。")
            stories.append(f"作为管理员，我可以配置「{epic}」的权限、规则和提示词，从而适配客户现场流程。")

        sprints = max(2, min(6, (len(epics) + len(integrations) + len(risks) + 1) // 2))
        return {"epics": epics, "stories": stories, "integrations": integrations, "risks": risks, "sprints": sprints}

    def _intake(self, request: WorkflowRequest, signals: dict) -> StageResult:
        content = dedent(
            f"""
            ## 业务目标
            {request.goal.strip()}

            ## 客户背景
            - 客户：{request.client_name or "内部项目"}
            - 行业：{request.industry or "软件服务"}
            - 目标用户：{request.target_users or "待确认"}

            ## 约束条件
            {request.constraints or "暂未提供明确约束。建议补充预算、周期、合规、部署方式和运维边界。"}

            ## 初步范围信号
            {self._bullets(signals["epics"])}
            """
        )
        return StageResult(
            id=WorkflowStage.intake,
            name="1. 需求接收与业务澄清",
            owner="需求分析 Agent",
            summary="把客户的口述需求、会议纪要和零散材料整理成可确认的项目简报。",
            artifacts=[Artifact(title="需求发现简报", content=content)],
        )

    def _product(self, signals: dict) -> StageResult:
        content = dedent(
            f"""
            ## 产品模块
            {self._bullets(signals["epics"])}

            ## 用户故事
            {self._bullets(signals["stories"])}

            ## 验收标准
            {self._bullets([
                "每条核心流程都具备明确的开始状态、成功状态和失败状态。",
                "用户可以看到任务处理状态，并能在异常时重试或联系人工处理。",
                "关键 AI 输出必须展示来源、复核状态或置信说明。",
            ])}
            """
        )
        return StageResult(
            id=WorkflowStage.product,
            name="2. PRD 与需求 Backlog",
            owner="产品经理 Agent",
            summary="把需求简报转成模块、用户故事和验收标准，方便客户确认和研发排期。",
            artifacts=[Artifact(title="PRD Backlog", content=content)],
        )

    def _architecture(self, request: WorkflowRequest, signals: dict) -> StageResult:
        stack = request.tech_stack or "Next.js 前端、FastAPI 后端、Postgres、Redis 队列、对象存储、向量数据库"
        content = dedent(
            f"""
            ## 推荐架构
            ```text
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
            ```

            ## 建议技术栈
            {stack}

            ## 外部集成
            {self._bullets(signals["integrations"] or ["暂未识别明确集成项。建议确认 GitHub、Jira、企业微信、CRM 或 ERP 需求。"])}

            ## 数据模型草案
            - Organization、User、Role
            - Project、Requirement、WorkflowRun
            - Artifact、Review、Approval
            - IntegrationCredential、AuditEvent、ModelUsage
            """
        )
        return StageResult(
            id=WorkflowStage.architecture,
            name="3. 技术方案与系统架构",
            owner="架构师 Agent",
            summary="定义产品架构、数据边界、集成方式和后续可扩展点。",
            artifacts=[Artifact(title="技术架构方案", content=content)],
        )

    def _delivery(self, signals: dict) -> StageResult:
        tasks = []
        for index, epic in enumerate(signals["epics"], 1):
            tasks.extend(
                [
                    f"DEV-{index}1：实现「{epic}」后端 API。",
                    f"DEV-{index}2：实现「{epic}」前端工作流。",
                    f"DEV-{index}3：补充「{epic}」审计日志、异常状态和权限校验。",
                ]
            )
        content = dedent(
            f"""
            ## 交付计划
            - 预估迭代数：{signals["sprints"]}
            - Sprint 0：项目初始化、环境、认证、CI/CD、部署路径
            - Sprint 1+：按产品模块交付核心功能
            - 最后迭代：安全加固、文档、UAT、上线清单

            ## Issue 草案
            {self._bullets(tasks)}
            """
        )
        return StageResult(
            id=WorkflowStage.delivery,
            name="4. 研发实施计划",
            owner="研发负责人 Agent",
            summary="把方案拆成迭代计划和可落地的研发任务。",
            artifacts=[Artifact(title="迭代计划与 Issue 草案", content=content)],
        )

    def _quality(self, signals: dict) -> StageResult:
        content = dedent(
            f"""
            ## 风险登记
            {self._bullets(signals["risks"])}

            ## 测试策略
            {self._bullets([
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
            """
        )
        return StageResult(
            id=WorkflowStage.quality,
            name="5. 测试、安全与代码评审",
            owner="QA 与 Review Agent",
            summary="生成风险清单、测试策略和上线前质量门禁。",
            artifacts=[Artifact(title="质量保障计划", content=content)],
        )

    def _handoff(self) -> StageResult:
        content = dedent(
            """
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
            """
        )
        return StageResult(
            id=WorkflowStage.handoff,
            name="6. 客户交付与运维闭环",
            owner="交付经理 Agent",
            summary="把研发成果整理成客户验收、上线和长期运营所需材料。",
            artifacts=[Artifact(title="交付清单", content=content)],
        )

    def _bullets(self, items: list[str]) -> str:
        return "\n".join(f"- {item}" for item in items)
