import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ssm from "aws-cdk-lib/aws-ssm";

export class PlaywrightMCPStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const connectionArn = `arn:aws:codeconnections:${this.region}:${this.account}:connection/b49882b2-aec0-4020-a219-fc3978a8cb89`;

    // ── ECR Repository ────────────────────────────────────────────────────
    // Import existing repo (retained from previous deploy)
    const ecrRepo = ecr.Repository.fromRepositoryName(this, "PlaywrightMCPRepo", "prompt2test-playwright-mcp");

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

    // ── VPC (public subnets, no NAT cost) ─────────────────────────────────
    const vpc = new ec2.Vpc(this, "PlaywrightVpc", {
      vpcName: "prompt2test-playwright-vpc",
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // ── Security Group ────────────────────────────────────────────────────
    const sg = new ec2.SecurityGroup(this, "PlaywrightSG", {
      vpc,
      securityGroupName: "prompt2test-playwright-mcp-sg",
      description: "Playwright MCP: port 3000 (MCP) + port 6080 (noVNC)",
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), "MCP SSE - agent connects here");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6080), "noVNC - watch browser live (headed mode)");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), "Health check port");

    // ── ECS Cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "PlaywrightCluster", {
      clusterName: "prompt2test-playwright-cluster",
      vpc,
    });

    // ── ECS Execution Role ────────────────────────────────────────────────
    const executionRole = new iam.Role(this, "ECSExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });
    ecrRepo.grantPull(executionRole);

    // ── Task Definition (ARM64 / Graviton) ────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "PlaywrightTaskDef", {
      family: "prompt2test-playwright-mcp",
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole,
    });

    taskDef.addContainer("playwright-mcp", {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, "latest"),
      containerName: "playwright-mcp",
      portMappings: [
        { containerPort: 3000, name: "mcp" },
        { containerPort: 6080, name: "novnc" },
        { containerPort: 8080, name: "health" },
      ],
      environment: {
        BROWSER_MODE: "headed",
        MCP_PORT: "3000",
        NOVNC_PORT: "6080",
        HEALTH_PORT: "8080",
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "playwright-mcp" }),
      // Health check: verify port 3000 is accepting connections (playwright-mcp has no /health route)
      healthCheck: {
        command: ["CMD-SHELL", "node -e \"require('net').createConnection(3000,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // ── SSM Parameters — agent reads these at runtime to call RunTask ────────
    // Stored in SSM so agent always gets current values without env var updates
    const subnetIds = vpc.publicSubnets.map(s => s.subnetId).join(",");

    new ssm.StringParameter(this, "ClusterNameParam", {
      parameterName: "/prompt2test/playwright/cluster-name",
      stringValue: cluster.clusterName,
      description: "ECS cluster name for RunTask",
    });

    new ssm.StringParameter(this, "TaskDefinitionFamilyParam", {
      parameterName: "/prompt2test/playwright/task-definition-family",
      stringValue: taskDef.family,
      description: "ECS task definition family — RunTask resolves to latest active revision",
    });

    new ssm.StringParameter(this, "SubnetIdsParam", {
      parameterName: "/prompt2test/playwright/subnet-ids",
      stringValue: subnetIds,
      description: "Comma-separated public subnet IDs for RunTask network config",
    });

    new ssm.StringParameter(this, "SecurityGroupIdParam", {
      parameterName: "/prompt2test/playwright/security-group-id",
      stringValue: sg.securityGroupId,
      description: "Security group ID for RunTask network config",
    });

    // ── CodePipeline: Source → Build only (no Deploy — agent spins up tasks on demand) ──
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
      description: "ECR repo — Playwright MCP Docker images",
    });

    new cdk.CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
      description: "ECS cluster — agent calls RunTask here",
    });

    new cdk.CfnOutput(this, "TaskDefinitionFamily", {
      value: taskDef.family,
      description: "Task definition family — agent uses this for RunTask (resolves to latest revision)",
    });

    new cdk.CfnOutput(this, "SubnetIds", {
      value: subnetIds,
      description: "Public subnet IDs — copy into AgentCore env var PLAYWRIGHT_SUBNET_IDS",
    });

    new cdk.CfnOutput(this, "SecurityGroupId", {
      value: sg.securityGroupId,
      description: "Security group ID — copy into AgentCore env var PLAYWRIGHT_SG_ID",
    });

    new cdk.CfnOutput(this, "PipelineConsoleUrl", {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/prompt2test-playwright-mcp-pipeline/view`,
      description: "CodePipeline — monitor builds",
    });
  }
}
