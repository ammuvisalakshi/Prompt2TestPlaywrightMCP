import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";

export class PlaywrightMCPStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // GitHub connection ARN (already authorized)
    const connectionArn = `arn:aws:codeconnections:${this.region}:${this.account}:connection/b49882b2-aec0-4020-a219-fc3978a8cb89`;

    // ── ECR Repository ────────────────────────────────────────────────────
    const ecrRepo = new ecr.Repository(this, "PlaywrightMCPRepo", {
      repositoryName: "prompt2test-playwright-mcp",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5, description: "Keep last 5 images" }],
    });

    // ── CloudWatch Log Group ──────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, "PlaywrightLogGroup", {
      logGroupName: "/prompt2test/playwright-mcp",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM Role for CodeBuild ────────────────────────────────────────────
    const codeBuildRole = new iam.Role(this, "CodeBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      inlinePolicies: {
        CodeBuildPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              actions: ["sts:GetCallerIdentity"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // ── CodeBuild Project (ARM64) ─────────────────────────────────────────
    const buildProject = new codebuild.PipelineProject(this, "PlaywrightBuildProject", {
      projectName: "prompt2test-playwright-mcp-build",
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
      },
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        IMAGE_REPO_NAME: { value: ecrRepo.repositoryName },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
      logging: { cloudWatch: { logGroup, prefix: "codebuild" } },
    });

    // ── CodePipeline: GitHub → Build → Push to ECR ────────────────────────
    const sourceOutput = new codepipeline.Artifact("SourceOutput");
    const buildOutput  = new codepipeline.Artifact("BuildOutput");

    new codepipeline.Pipeline(this, "PlaywrightPipeline", {
      pipelineName: "prompt2test-playwright-mcp-pipeline",
      stages: [
        {
          stageName: "Source",
          actions: [
            new codepipeline_actions.CodeStarConnectionsSourceAction({
              actionName: "GitHub_Source",
              owner: "ammuvisalakshi",
              repo: "Prompt2TestPlaywrightMCP",
              branch: "master",
              connectionArn,
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: "Build",
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: "Build_and_Push_to_ECR",
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
      ],
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ECRRepositoryUri", {
      value: ecrRepo.repositoryUri,
      description: "ECR repo — push Playwright MCP images here",
    });

    new cdk.CfnOutput(this, "PipelineConsoleUrl", {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/prompt2test-playwright-mcp-pipeline/view`,
      description: "CodePipeline — monitor builds",
    });
  }
}
