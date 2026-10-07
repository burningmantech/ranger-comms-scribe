import {
  Duration,
  RemovalPolicy,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScribeConfig } from './config';
import { backendEnvironment } from './shared';

export interface ExistingListener {
  listenerArn: string;
  securityGroupId: string;
  /** Rule priority on the shared listener; must be unique there. */
  priority: number;
}

export interface ScribeServiceProps {
  config: ScribeConfig;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  /** Subnets for the task. */
  taskSubnets: ec2.SubnetSelection;
  /** Subnets for a stack-created ALB. */
  albSubnets: ec2.SubnetSelection;
  assignPublicIp: boolean;
  image: ecs.ContainerImage;
  taskRole: iam.IRole;
  executionRole: iam.IRole;
  logGroup: logs.ILogGroup;
  turnstileSecret: ecs.Secret;
  capacityProvider: 'FARGATE' | 'FARGATE_SPOT';
  desiredCount: number;
  albCertificate: acm.ICertificate;
  /**
   * Standard profile: route by host header. On a stack-created ALB this adds a host rule and a
   * 404 default; with `existingListener` it adds the rule to the shared listener instead.
   */
  hostRouting: boolean;
  existingListener?: ExistingListener;
}

/**
 * The single-container Fargate service behind an ALB. ranger-deploy requires exactly one
 * container per task definition, so nothing else (no sidecars) goes in here.
 */
export class ScribeService extends Construct {
  readonly service: ecs.FargateService;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  /** Undefined when attached to an existing listener. */
  readonly loadBalancer?: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ScribeServiceProps) {
    super(scope, id);
    const { config } = props;

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: config.ecs.serviceName,
      cpu: config.ecs.cpu,
      memoryLimitMiB: config.ecs.memoryMiB,
      taskRole: props.taskRole,
      executionRole: props.executionRole,
      // Laptops build with --platform linux/amd64; pin the task to match.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    this.taskDefinition.addContainer('app', {
      containerName: 'comms-scribe',
      image: props.image,
      essential: true,
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      environment: backendEnvironment(config),
      secrets: { TURNSTILESECRET: props.turnstileSecret },
      logging: ecs.LogDrivers.awsLogs({ logGroup: props.logGroup, streamPrefix: 'app' }),
      stopTimeout: Duration.seconds(30),
    });

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc: props.vpc,
      description: `${config.ecs.serviceName} task: inbound only from the ALB`,
      allowAllOutbound: true,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      serviceName: config.ecs.serviceName,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount,
      capacityProviderStrategies: [{ capacityProvider: props.capacityProvider, weight: 1 }],
      assignPublicIp: props.assignPublicIp,
      vpcSubnets: props.taskSubnets,
      securityGroups: [taskSecurityGroup],
      // One task at a time: rooms and cache live in process memory (PRD §7.2). With
      // overlapDeploys the new task starts before the old one stops (no outage, a few
      // seconds of two tasks).
      minHealthyPercent: config.ecs.overlapDeploys ? 100 : 0,
      maxHealthyPercent: config.ecs.overlapDeploys ? 200 : 100,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });

    const healthCheckInterval = config.ecs.healthCheckIntervalSeconds ?? 15;
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(10),
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: Duration.seconds(healthCheckInterval),
        timeout: Duration.seconds(Math.min(5, healthCheckInterval - 1)),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      targets: [this.service],
    });

    const hostCondition = elbv2.ListenerCondition.hostHeaders([config.hostname]);

    if (props.existingListener) {
      // The shared ALB and its security group belong to the tech team: its ingress is left
      // alone here (see infra/README.md, "ALB ingress").
      const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'SharedListener', {
        listenerArn: props.existingListener.listenerArn,
        securityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, 'SharedAlbSg', props.existingListener.securityGroupId),
      });
      listener.addCertificates('HostCertificate', [elbv2.ListenerCertificate.fromCertificateManager(props.albCertificate)]);
      listener.addTargetGroups('HostRule', {
        priority: props.existingListener.priority,
        conditions: [hostCondition],
        targetGroups: [this.targetGroup],
      });
      return;
    }

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: props.albSubnets,
      // WebSockets: above the client's 30 s ping/heartbeat with margin (PRD §10).
      idleTimeout: Duration.seconds(120),
      dropInvalidHeaderFields: true,
    });
    this.loadBalancer = alb;

    // Only CloudFront may reach the ALB, so clients can't bypass its headers (HSTS) and
    // routing. The one ingress rule allows CloudFront's origin-facing managed prefix list on
    // 443. That prefix list counts as ~55 rules toward the 60-rules-per-security-group quota,
    // so there is deliberately no second (port 80) rule, and no port 80 listener: CloudFront
    // connects HTTPS_ONLY (shared.ts), so plain HTTP never reaches the ALB.
    alb.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontOriginFacingPrefixListId(this)),
      ec2.Port.tcp(443),
      'HTTPS from CloudFront (origin-facing managed prefix list)',
    );

    const https = alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromCertificateManager(props.albCertificate)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      // No 0.0.0.0/0 rule: ingress is the CloudFront rule above.
      open: false,
      defaultAction: props.hostRouting
        ? elbv2.ListenerAction.fixedResponse(404, { contentType: 'application/json', messageBody: '{"error":"Unknown host"}' })
        : elbv2.ListenerAction.forward([this.targetGroup]),
    });
    if (props.hostRouting) {
      https.addTargetGroups('HostRule', { priority: 10, conditions: [hostCondition], targetGroups: [this.targetGroup] });
    }
  }
}

/** Name of the AWS-managed prefix list of CloudFront's origin-facing addresses. */
export const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = 'com.amazonaws.global.cloudfront.origin-facing';

/**
 * ID of the CloudFront origin-facing managed prefix list, resolved at deploy time by a custom
 * resource (EC2 DescribeManagedPrefixLists). The ID differs per region; a context lookup would
 * make `cdk synth` call AWS, which must work offline (contracts §6).
 */
function cloudFrontOriginFacingPrefixListId(scope: Construct): string {
  const call: cr.AwsSdkCall = {
    service: 'EC2',
    action: 'describeManagedPrefixLists',
    parameters: {
      Filters: [{ Name: 'prefix-list-name', Values: [CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST] }],
    },
    physicalResourceId: cr.PhysicalResourceId.of(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST),
    outputPaths: ['PrefixLists.0.PrefixListId'],
  };
  const lookup = new cr.AwsCustomResource(scope, 'CloudFrontPrefixListLookup', {
    onCreate: call,
    onUpdate: call,
    policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    installLatestAwsSdk: false,
    // Owned by the stack, so dev's wake/sleep cycles don't leave a log group behind each time.
    logGroup: new logs.LogGroup(scope, 'CloudFrontPrefixListLookupLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    }),
  });
  return lookup.getResponseField('PrefixLists.0.PrefixListId');
}

