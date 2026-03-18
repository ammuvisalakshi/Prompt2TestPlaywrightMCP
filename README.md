# Prompt2Test — Playwright MCP Server

Standalone Playwright MCP server deployed on **AWS ECS Fargate (ARM64/Graviton)** with support for both **headed** (Xvfb + noVNC) and **headless** browser modes.

## Architecture

```
GitHub push → CodePipeline → CodeBuild (ARM64) → ECR → ECS Fargate
                                                         ↓
                                              ALB :3000 (MCP SSE)
                                              ALB :6080 (noVNC viewer)
```

## Ports

| Port | Purpose |
|------|---------|
| 3000 | Playwright MCP SSE endpoint — agent connects here |
| 6080 | noVNC web viewer — watch browser live (headed mode only) |

## Browser Modes

Set the `BROWSER_MODE` environment variable on the ECS task:

- `headless` (default) — no display, faster, lower memory
- `headed` — Xvfb virtual display + noVNC viewer at `:6080/vnc.html`

## Local Development

```bash
# Build
docker build -t playwright-mcp .

# Run headless
docker run -p 3000:3000 -e BROWSER_MODE=headless playwright-mcp

# Run headed (watch browser via http://localhost:6080/vnc.html)
docker run -p 3000:3000 -p 6080:6080 -e BROWSER_MODE=headed playwright-mcp
```

## CI/CD

Push to `master` branch → CodePipeline automatically builds and pushes a new ARM64 Docker image to ECR.

## Infrastructure (CDK)

```bash
cd infra
npm install
npx cdk deploy
```

Outputs:
- `ECRRepositoryUri` — ECR repo URI
- `PlaywrightMCPEndpoint` — MCP SSE endpoint (set as `PLAYWRIGHT_MCP_ENDPOINT` in AgentCore)
- `NoVNCUrl` — noVNC browser viewer URL
- `PipelineConsoleUrl` — CodePipeline console link
