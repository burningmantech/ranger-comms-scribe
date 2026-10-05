import {
  Annotations,
  CfnOutput,
  StackProps,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScribeStack } from './scribe-stack';
import { ScribeConfig } from './config';
import { devLogGroupName, devParameterNames, devRoleNames, originHostname } from './dev-persistent-stack';
import { ScribeService } from './scribe-service';

/** The dev image tag. CDK and bin/dev-deploy always agree on it (PRD §7.2). */
export const DEV_IMAGE_TAG = 'dev';

/**
 * Everything that costs money by the hour: ALB, listeners, target group, Fargate Spot service and
 * the origin.<host> alias. `bin/dev-up` deploys it, `bin/dev-down` destroys it.
 *
 * It references the persistent stack only through SSM parameters (resolved at deploy time) and
 * deterministic names, never through CloudFormation exports.
 */
export class DevComputeStack extends ScribeStack {
  constructor(scope: Construct, id: string, config: ScribeConfig, props: StackProps & { desiredCount?: number }) {
    super(scope, id, config, props);
    const names = devParameterNames(config);
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: param(names.vpcId),
      availabilityZones: config.availabilityZones,
      publicSubnetIds: names.publicSubnetIds.map((name) => param(name)),
    });
    // Route table IDs are irrelevant here (no routes or gateway endpoints are added in this stack).
    Annotations.of(vpc).acknowledgeWarning('@aws-cdk/aws-ec2:noSubnetRouteTableId', 'No route changes in the compute stack');

    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName: config.ecs.clusterName,
      vpc,
      securityGroups: [],
    });

    const repository = ecr.Repository.fromRepositoryName(this, 'Repository', config.ecr.repositoryName);
    const logGroup = logs.LogGroup.fromLogGroupName(this, 'LogGroup', devLogGroupName(config));
    // Immutable: their policies are managed in the persistent stack.
    const roleNames = devRoleNames(config);
    const taskRole = iam.Role.fromRoleName(this, 'TaskRole', roleNames.task, { mutable: false });
    const executionRole = iam.Role.fromRoleName(this, 'ExecutionRole', roleNames.execution, { mutable: false });
    const albCertificate = acm.Certificate.fromCertificateArn(this, 'AlbCertificate', param(names.albCertificateArn));
    const turnstileParameter = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'TurnstileSecret', {
      parameterName: config.turnstileSecretName,
    });

    const scribe = new ScribeService(this, 'Scribe', {
      config,
      vpc,
      cluster,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      albSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      image: ecs.ContainerImage.fromEcrRepository(repository, DEV_IMAGE_TAG),
      taskRole,
      executionRole,
      logGroup,
      turnstileSecret: ecs.Secret.fromSsmParameter(turnstileParameter),
      capacityProvider: 'FARGATE_SPOT',
      desiredCount: props.desiredCount ?? 1,
      albCertificate,
      hostRouting: false,
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: param(names.hostedZoneId),
      zoneName: config.hostname,
    });
    new route53.ARecord(this, 'OriginAlias', {
      zone,
      recordName: originHostname(config),
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(scribe.loadBalancer!)),
    });

    new CfnOutput(this, 'ServiceName', { value: scribe.service.serviceName });
    new CfnOutput(this, 'LoadBalancerDnsName', { value: scribe.loadBalancer!.loadBalancerDnsName });
  }
}
