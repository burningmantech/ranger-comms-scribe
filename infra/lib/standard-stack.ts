import {
  CfnOutput,
  StackProps,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScribeStack } from './scribe-stack';
import { ScribeConfig, logRetentionDays } from './config';
import { ScribeService } from './scribe-service';
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

export interface StandardStackProps extends StackProps {
  /** Currently deployed image tag (commit ID). Required so CDK never rolls back ranger-deploy's image. */
  imageTag: string;
  desiredCount?: number;
}

/**
 * Standard profile (Rangers account): one always-on stack per environment, on-demand Fargate.
 * Uses the tech team's VPC, cluster and shared ALB listener when `useExisting` is configured,
 * otherwise creates its own.
 */
export class StandardStack extends ScribeStack {
  constructor(scope: Construct, id: string, config: ScribeConfig, props: StandardStackProps) {
    super(scope, id, config, props);
    const removalPolicy = removalPolicyFor(config);
    const existing = config.useExisting;

    // Network and cluster.
    let vpc: ec2.IVpc;
    let cluster: ecs.ICluster;
    let taskSubnets: ec2.SubnetSelection;
    let assignPublicIp: boolean;
    if (existing) {
      vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: existing.vpcId });
      cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
        clusterName: existing.clusterName,
        vpc,
        securityGroups: [],
      });
      // Assumption: the tech team's VPC has private subnets with NAT egress.
      taskSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
      assignPublicIp = false;
    } else {
      vpc = createVpc(this, config);
      cluster = new ecs.Cluster(this, 'Cluster', {
        clusterName: config.ecs.clusterName,
        vpc,
        enableFargateCapacityProviders: true,
      });
      taskSubnets = { subnetType: ec2.SubnetType.PUBLIC };
      assignPublicIp = true;
    }

    // Certificates. Without ARNs, one DNS-validated certificate (manual validation: add the CNAMEs
    // CloudFormation shows to the hostname's DNS) serves both CloudFront and, in us-east-1, the ALB.
    let created: acm.Certificate | undefined;
    const createdCertificate = () =>
      (created ??= new acm.Certificate(this, 'Certificate', {
        domainName: config.hostname,
        validation: acm.CertificateValidation.fromDns(),
      }));
    const cloudFrontCertificate = config.certificates?.cloudFrontCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'CloudFrontCertificate', config.certificates.cloudFrontCertificateArn)
      : createdCertificate();
    const albCertificate = config.certificates?.albCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'AlbCertificate', config.certificates.albCertificateArn)
      : createdCertificate();

    // Storage and image repository.
    const spaBucket = createSpaBucket(this, config);
    const dataBucket = createDataBucket(this, config);
    const repository = repositoryFor(this, config);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/scribe-${config.name}`,
      retention: logRetentionDays(config) as logs.RetentionDays,
      removalPolicy,
    });

    // The stack creates the secret with a random placeholder value; set the real value afterwards.
    const turnstileSecret = new secretsmanager.Secret(this, 'TurnstileSecret', {
      secretName: config.turnstileSecretName,
      description: `Comms Scribe ${config.name} Cloudflare Turnstile secret key (set the value by hand)`,
      removalPolicy,
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    grantTaskRole(taskRole, dataBucket);

    const scribe = new ScribeService(this, 'Scribe', {
      config,
      vpc,
      cluster,
      taskSubnets,
      albSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp,
      image: ecs.ContainerImage.fromEcrRepository(repository, props.imageTag),
      taskRole,
      executionRole,
      logGroup,
      turnstileSecret: ecs.Secret.fromSecretsManager(turnstileSecret),
      capacityProvider: 'FARGATE',
      desiredCount: props.desiredCount ?? 1,
      albCertificate,
      hostRouting: true,
      existingListener: existing?.albListenerArn
        ? {
            listenerArn: existing.albListenerArn,
            securityGroupId: existing.albSecurityGroupId!,
            priority: existing.albRulePriority ?? 100,
          }
        : undefined,
    });

    const apiOriginDomain = existing?.albListenerArn ? existing.albDnsName! : scribe.loadBalancer!.loadBalancerDnsName;
    const distribution = createDistribution(this, {
      config,
      spaBucket,
      apiOriginDomain,
      certificate: cloudFrontCertificate,
      forwardViewerHost: true,
    });

    createSesIdentity(this, config);

    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      description: `Point ${config.hostname} (CNAME or alias) at this`,
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'SpaBucketName', { value: spaBucket.bucketName });
    new CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: scribe.service.serviceName });
    new CfnOutput(this, 'TurnstileSecretName', { value: turnstileSecret.secretName });
  }
}
