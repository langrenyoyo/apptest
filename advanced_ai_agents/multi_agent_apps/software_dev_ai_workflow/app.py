from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from workflow import WorkflowEngine, WorkflowRequest, WorkflowResponse

app = FastAPI(
    title="软件开发公司 AI 工作流",
    description="面向软件开发公司的 AI 交付工作流 MVP。",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8901", "http://127.0.0.1:8901"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = WorkflowEngine()
last_run: WorkflowResponse | None = None

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/health")
async def health():
    return {"status": "ok", "app": "software-dev-ai-workflow", "language": "zh-CN"}


@app.post("/api/workflows/run", response_model=WorkflowResponse)
async def run_workflow(request: WorkflowRequest):
    global last_run
    last_run = engine.run(request)
    return last_run


@app.get("/api/workflows/latest/export", response_class=PlainTextResponse)
async def export_latest():
    if last_run is None:
        return "No workflow has been generated yet.\n"
    return engine.export_markdown(last_run)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8901)
