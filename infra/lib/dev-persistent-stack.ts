import {
  CfnOutput,
  Fn,
  Stack,
  StackProps,
  aws_budgets as budgets,
  aws_certificatemanager as acm,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScribeStack } from './scribe-stack';
import { ScribeConfig, logRetentionDays, ssmPrefix } from './config';
import {
  createDataBucket,
  createDistribution,
  createSesIdentity,
  createSpaBucket,
  createVpc,
  grantTaskRole,
  removalPolicyFor,
  repositoryFor,
} from './shared';

/**
 * Names of the SSM String parameters the persistent stack publishes. The compute stack and the
 * bin/ scripts read them, so the two stacks share no CloudFormation exports and the compute stack
 * can be destroyed and recreated freely (PRD §7.6).
 */
export function devParameterNames(config: ScribeConfig) {
  const p = ssmPrefix(config);
  return {
    vpcId: `${p}/vpc-id`,
    publicSubnetIds: config.availabilityZones.map((_, i) => `${p}/public-subnet-${i}`),
    hostedZoneId: `${p}/hosted-zone-id`,
    albCertificateArn: `${p}/alb-certificate-arn`,
    // Used by bin/dev-deploy:
    clusterName: `${p}/cluster-name`,
    serviceName: `${p}/service-name`,
    repositoryUri: `${p}/ecr-repository-uri`,
    spaBucket: `${p}/spa-bucket`,
    distributionId: `${p}/distribution-id`,
  };
}

export function devLogGroupName(config: ScribeConfig): string {
  return `/ecs/scribe-${config.name}`;
}

/** Deterministic role names so the compute stack can import them without exports. */
export function devRoleNames(config: ScribeConfig) {
  return {
    task: `scribe-${config.name}-task`,
    execution: `scribe-${config.name}-execution`,
  };
}

export function originHostname(config: ScribeConfig): string {
  return `origin.${config.hostname}`;
}

export class DevPersistentStack extends ScribeStack {
  constructor(scope: Construct, id: string, config: ScribeConfig, props: StackProps) {
    super(scope, id, config, props);
    const names = devParameterNames(config);
    const removalPolicy = removalPolicyFor(config);

    // DNS: zone for app.scrivenly.com, delegated from Cloudflare with NS records.
    const zone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: config.hostname,
      comment: `Comms Scribe ${config.name}; delegated from the parent zone by NS records`,
    });
    zone.applyRemovalPolicy(removalPolicy);

    const cloudFrontCertificate = config.certificates?.cloudFrontCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'CloudFrontCertificate', config.certificates.cloudFrontCertificateArn)
      : new acm.Certificate(this, 'CloudFrontCertificate', {
          domainName: config.hostname,
          validation: acm.CertificateValidation.fromDns(zone),
        });

    // Regional certificate for the ALB (created now so waking up never waits on ACM).
    const albCertificate = config.certificates?.albCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'AlbCertificate', config.certificates.albCertificateArn)
      : new acm.Certificate(this, 'AlbCertificate', {
          domainName: originHostname(config),
          subjectAlternativeNames: [config.hostname],
          validation: acm.CertificateValidation.fromDns(zone),
        });

    // Storage.
    const spaBucket = createSpaBucket(this, config);
    const dataBucket = createDataBucket(this, config);
    const repository = repositoryFor(this, config);

    // CloudFront. The API origin is the stable origin.<host> name, so sleep/wake never edits it.
    const distribution = createDistribution(this, {
      config,
      spaBucket,
      apiOriginDomain: originHostname(config),
      certificate: cloudFrontCertificate,
      forwardViewerHost: false,
    });
    for (const [id, Record] of [
      ['ApexA', route53.ARecord],
      ['ApexAaaa', route53.AaaaRecord],
    ] as const) {
      new Record(this, id, {
        zone,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    // Network and cluster (no NAT; the task gets a public IP while awake).
    const vpc = createVpc(this, config);
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: config.ecs.clusterName,
      vpc,
      enableFargateCapacityProviders: true,
    });

    // Logs.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: devLogGroupName(config),
      retention: logRetentionDays(config) as logs.RetentionDays,
      removalPolicy,
    });

    // IAM. All grants live here because the compute stack imports these roles as immutable.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: devRoleNames(config).execution,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Comms Scribe ${config.name} ECS task execution role`,
    });
    repository.grantPull(executionRole);
    logGroup.grantWrite(executionRole);
    // TURNSTILESECRET is an SSM SecureString created by hand (never by CDK, so no value is in git).
    // It uses the AWS-managed aws/ssm key, which needs no extra kms:Decrypt grant.
    const turnstileParameterArn = Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: config.turnstileSecretName.replace(/^\//, ''),
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameters', 'ssm:GetParameter'], resources: [turnstileParameterArn] }),
    );

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: devRoleNames(config).task,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Comms Scribe ${config.name} application role (S3 data bucket, SES)`,
    });
    grantTaskRole(taskRole, dataBucket);

    // SES identity for EMAIL_FROM's domain; add the DKIM outputs to that domain's DNS (Cloudflare).
    createSesIdentity(this, config);

    // Cost guardrail.
    if (config.budget) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `scribe-${config.name}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: config.budget.monthlyLimitUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
            subscribers: [{ subscriptionType: 'EMAIL', address: config.budget.alertEmail }],
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
            subscribers: [{ subscriptionType: 'EMAIL', address: config.budget.alertEmail }],
          },
        ],
      });
    }

    // Values for the compute stack and bin/ scripts (SSM, not exports).
    const publish = (id: string, parameterName: string, stringValue: string) =>
      new ssm.StringParameter(this, id, { parameterName, stringValue, description: `Comms Scribe ${config.name}` });
    publish('ParamVpcId', names.vpcId, vpc.vpcId);
    vpc.publicSubnets.forEach((subnet, i) => publish(`ParamPublicSubnet${i}`, names.publicSubnetIds[i], subnet.subnetId));
    publish('ParamHostedZoneId', names.hostedZoneId, zone.hostedZoneId);
    publish('ParamAlbCertificateArn', names.albCertificateArn, albCertificate.certificateArn);
    publish('ParamClusterName', names.clusterName, cluster.clusterName);
    publish('ParamServiceName', names.serviceName, config.ecs.serviceName);
    publish('ParamRepositoryUri', names.repositoryUri, repository.repositoryUri);
    publish('ParamSpaBucket', names.spaBucket, spaBucket.bucketName);
    publish('ParamDistributionId', names.distributionId, distribution.distributionId);

    // Outputs (no exportName, so nothing blocks either stack).
    new CfnOutput(this, 'HostedZoneNameServers', {
      description: `Add these as NS records for ${config.hostname} in the parent (Cloudflare) zone`,
      value: Fn.join(', ', zone.hostedZoneNameServers ?? []),
    });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'SpaBucketName', { value: spaBucket.bucketName });
    new CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'TurnstileSecretParameter', {
      description: 'Create this SSM SecureString by hand before bin/dev-up',
      value: config.turnstileSecretName,
    });
  }
}
