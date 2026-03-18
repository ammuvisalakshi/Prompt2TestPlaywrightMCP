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
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";

export class PlaywrightMCPStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // GitHub connection ARN (already authorized in Prompt2TestAgent setup)
    const connectionArn = `arn:aws:codeconnections:${this.region}:${this.account}:connection/b49882b2-aec0-4020-a219-fc3978a8cb89`;

    // ── CloudWatch Log Group ─────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, "PlaywrightLogGroup", {
      logGroupName: "/prompt2test/playwright-mcp",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── ECR Repository ───────────────────────────────────────────────────
    const ecrRepo = new ecr.Repository(this, "PlaywrightMCPRepository", {
      repositoryName: "prompt2test-playwright-mcp",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5, description: "Keep last 5 images" }],
    });

    // ── IAM Role for CodeBuild ───────────────────────────────────────────
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

    // ── CodeBuild Project (ARM64) ────────────────────────────────────────
    const buildProject = new codebuild.PipelineProject(this, "PlaywrightBuildProject", {
      projectName: "prompt2test-playwright-mcp-build",
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // Required for Docker builds
      },
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        IMAGE_REPO_NAME: { value: ecrRepo.repositoryName },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
      logging: { cloudWatch: { logGroup, prefix: "codebuild" } },
    });

    // ── CodePipeline — pulls from GitHub, builds, pushes to ECR ─────────
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

    // ── VPC (public subnets only — no NAT cost) ───────────────────────────
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

    // ── ECS Cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "PlaywrightCluster", {
      clusterName: "prompt2test-playwright-cluster",
      vpc,
    });

    // ── ECS Execution Role ────────────────────────────────────────────────
    const executionRole = new iam.Role(this, "ECSExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });
    ecrRepo.grantPull(executionRole);

    // ── Task Definition (ARM64 / Graviton) ────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "PlaywrightTaskDef", {
      family: "prompt2test-playwright-mcp",
      cpu: 1024,         // 1 vCPU
      memoryLimitMiB: 2048,  // 2 GB — Chromium needs memory
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
        { containerPort: 3000, name: "mcp"   },
        { containerPort: 6080, name: "novnc" },
      ],
      environment: {
        // Change to "headed" for DEV to watch browser via noVNC
        BROWSER_MODE: "headless",
        MCP_PORT: "3000",
        NOVNC_PORT: "6080",
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "playwright-mcp",
      }),
      healthCheck: {
        command: ["CMD-SHELL",
          "node -e \"require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    // ── ALB — stable DNS endpoint for the agent ───────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "PlaywrightALB", {
      loadBalancerName: "prompt2test-playwright-mcp",
      vpc,
      internetFacing: true,
      securityGroup: sg,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "PlaywrightTargetGroup", {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: "200",
      },
    });

    alb.addListener("MCPListener", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ── ECS Fargate Service ───────────────────────────────────────────────
    const service = new ecs.FargateService(this, "PlaywrightService", {
      serviceName: "prompt2test-playwright-mcp",
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [sg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    service.attachToApplicationTargetGroup(targetGroup);

    // ── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ECRRepositoryUri", {
      value: ecrRepo.repositoryUri,
      description: "ECR repo — Playwright MCP Docker images",
    });

    new cdk.CfnOutput(this, "PlaywrightMCPEndpoint", {
      value: `http://${alb.loadBalancerDnsName}:3000`,
      description: "MCP SSE endpoint — set as PLAYWRIGHT_MCP_ENDPOINT in AgentCore",
      exportName: "Prompt2TestPlaywrightMCPEndpoint",
    });

    new cdk.CfnOutput(this, "NoVNCUrl", {
      value: `http://${alb.loadBalancerDnsName}:6080/vnc.html`,
      description: "noVNC URL — watch headed browser live (set BROWSER_MODE=headed in ECS task)",
    });

    new cdk.CfnOutput(this, "PipelineConsoleUrl", {
      value: `https://${this.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/prompt2test-playwright-mcp-pipeline/view`,
      description: "CodePipeline — monitor Playwright MCP deployments",
    });
  }
}
