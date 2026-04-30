from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class WorkflowStage(str, Enum):
    intake = "intake"
    product = "product"
    architecture = "architecture"
    delivery = "delivery"
    quality = "quality"
    handoff = "handoff"


class WorkflowRequest(BaseModel):
    project_name: str = Field(min_length=2, max_length=120)
    client_name: str = Field(default="", max_length=120)
    industry: str = Field(default="software", max_length=80)
    goal: str = Field(min_length=10)
    source_material: str = Field(default="", description="Meeting notes, RFP, chat logs, or raw requirements")
    constraints: str = Field(default="", description="Budget, schedule, compliance, stack, or staffing constraints")
    target_users: str = Field(default="", description="Primary users and stakeholders")
    tech_stack: str = Field(default="", description="Preferred stack or existing systems")


class Artifact(BaseModel):
    title: str
    content: str
    kind: str = "markdown"


class StageResult(BaseModel):
    id: WorkflowStage
    name: str
    owner: str
    status: str = "completed"
    summary: str
    artifacts: list[Artifact]


class WorkflowResponse(BaseModel):
    workflow_id: str = Field(default_factory=lambda: uuid4().hex[:10])
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    project_name: str
    client_name: str = ""
    stages: list[StageResult]
    metrics: dict[str, Any]
    next_actions: list[str]
