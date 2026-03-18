#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { PlaywrightMCPStack } from "../lib/playwright-mcp-stack";

const app = new cdk.App();

new PlaywrightMCPStack(app, "PlaywrightMCPStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Prompt2Test — Playwright MCP Server (ECS Fargate ARM64, headed + headless)",
});
