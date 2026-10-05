import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEV_COMPUTE_STACK, DEV_PERSISTENT_STACK, buildApp } from '../lib/app';

// Use the same feature flags as the CLI (cdk.json) so tests match `cdk synth`.
const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
const baseContext: Record<string, unknown> = cdkJson.context;

function synthApp(context: Record<string, unknown>): App {
  return buildApp({ ...baseContext, ...context });
}

function template(app: App, stackName: string): Template {
  return Template.fromStack(app.node.findChild(stackName) as Stack);
}

// AllViewerAndCloudFrontHeaders-2022-06: viewer headers incl. Host, plus CloudFront-Viewer-Address.
const MANAGED_ALL_VIEWER_AND_CLOUDFRONT = '33f36d7e-f396-46d9-90e0-52428a34d9dc';
const MANAGED_ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
const MANAGED_CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

describe('alex-dev (dev profile)', () => {
  const app = synthApp({ config: 'alex-dev' });
  const persistent = template(app, DEV_PERSISTENT_STACK);
  const compute = template(app, DEV_COMPUTE_STACK);

  test('synthesizes without context lookups (offline)', () => {
    const assembly = app.synth();
    expect(assembly.manifest.missing ?? []).toEqual([]);
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual([DEV_COMPUTE_STACK, DEV_PERSISTENT_STACK]);
  });

  test('has no NAT gateway', () => {
    persistent.resourceCountIs('AWS::EC2::NatGateway', 0);
    compute.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('VPC has public subnets only and an S3 gateway endpoint', () => {
    persistent.resourceCountIs('AWS::EC2::Subnet', 2);
    persistent.allResourcesProperties('AWS::EC2::Subnet', { MapPublicIpOnLaunch: true });
    persistent.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('\\.s3$')])]) }),
    });
  });

  test('task definition has exactly one container', () => {
    compute.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    const taskDefs = compute.findResources('AWS::ECS::TaskDefinition');
    const [taskDef] = Object.values(taskDefs);
    expect(taskDef.Properties.ContainerDefinitions).toHaveLength(1);
    const [container] = taskDef.Properties.ContainerDefinitions;
    expect(container.PortMappings).toEqual([{ ContainerPort: 8080, Protocol: 'tcp' }]);
    expect(container.LogConfiguration.LogDriver).toBe('awslogs');
    expect(container.Secrets).toEqual([{ Name: 'TURNSTILESECRET', ValueFrom: expect.anything() }]);
    expect(JSON.stringify(container.Image)).toContain('/comms-scribe:dev');
    expect(taskDef.Properties.RuntimePlatform).toEqual({ CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' });
  });

  test('service runs one task on FARGATE_SPOT only, with a public IP, 0%/100% deployments', () => {
    compute.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }],
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }) },
    });
    persistent.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
      CapacityProviders: Match.arrayWith(['FARGATE_SPOT']),
    });
  });

  test('task security group only accepts traffic from the ALB', () => {
    const ingress = compute.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(ingress)).toHaveLength(1);
    const [rule] = Object.values(ingress);
    expect(rule.Properties.FromPort).toBe(8080);
    expect(JSON.stringify(rule.Properties.SourceSecurityGroupId)).toContain('Alb');
    const groups = compute.findResources('AWS::EC2::SecurityGroup');
    const taskGroup = Object.entries(groups).find(([id]) => id.includes('TaskSecurityGroup'))![1];
    expect(taskGroup.Properties.SecurityGroupIngress).toBeUndefined();
  });

  test('ALB idle timeout is at least 120 s and health check is /healthz', () => {
    compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '120' }]),
    });
    compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/healthz' });
    compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect' })],
    });
  });

  test('compute stack shares nothing with persistent through exports', () => {
    expect(JSON.stringify(compute.toJSON())).not.toContain('Fn::ImportValue');
    for (const output of Object.values(persistent.toJSON().Outputs ?? {}) as Array<Record<string, unknown>>) {
      expect(output.Export).toBeUndefined();
    }
  });

  test('CloudFront: SPA rewrite function, no custom error responses, gallery before /api/*', () => {
    const distributions = persistent.findResources('AWS::CloudFront::Distribution');
    expect(Object.keys(distributions)).toHaveLength(1);
    const config = Object.values(distributions)[0].Properties.DistributionConfig;
    expect(config.CustomErrorResponses).toBeUndefined();
    expect(config.DefaultCacheBehavior.FunctionAssociations).toEqual([
      { EventType: 'viewer-request', FunctionARN: expect.anything() },
    ]);
    expect(config.CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern)).toEqual(['/api/gallery/*', '/api/*']);
    const api = config.CacheBehaviors[1];
    expect(api.CachePolicyId).toBe(MANAGED_CACHING_DISABLED);
    expect(api.OriginRequestPolicyId).toBe(MANAGED_ALL_VIEWER_EXCEPT_HOST);
    expect(config.Origins.map((o: { DomainName: unknown }) => o.DomainName)).toContain('origin.aws-dev.scrivenly.com');
    persistent.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({ StrictTransportSecurity: Match.objectLike({ IncludeSubdomains: true }) }),
      }),
    });
  });

  test('data bucket: versioning, ephemeral-prefix expiry, noncurrent expiry, public access blocked', () => {
    persistent.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'session/', ExpirationInDays: 14 }),
          Match.objectLike({ Prefix: 'verification-token/', ExpirationInDays: 14 }),
          Match.objectLike({ Prefix: 'reset-token/', ExpirationInDays: 14 }),
          Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } }),
        ]),
      },
    });
  });

  test('ECR lifecycle expires untagged images and keeps 10 tagged', () => {
    const repos = persistent.findResources('AWS::ECR::Repository');
    const [repo] = Object.values(repos);
    expect(repo.Properties.RepositoryName).toBe('comms-scribe');
    const policy = JSON.parse(repo.Properties.LifecyclePolicy.LifecyclePolicyText);
    expect(policy.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selection: expect.objectContaining({ tagStatus: 'untagged' }) }),
        expect.objectContaining({
          selection: expect.objectContaining({ tagStatus: 'tagged', countType: 'imageCountMoreThan', countNumber: 10 }),
        }),
      ]),
    );
  });

  test('logs keep 7 days, budget alert at $15', () => {
    persistent.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    persistent.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 15, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
    });
  });

  test('TURNSTILESECRET is referenced, never created', () => {
    persistent.resourcePropertiesCountIs('AWS::SSM::Parameter', { Name: Match.stringLikeRegexp('TURNSTILESECRET') }, 0);
  });
});

describe.each(['rangers-staging', 'rangers-production'])('%s (standard profile)', (configName) => {
  test('requires an imageTag', () => {
    expect(() => synthApp({ config: configName })).toThrow(/imageTag/);
  });

  const app = synthApp({ config: configName, imageTag: 'abc1234' });
  const stack = template(app, `scribe-${configName}`);

  test('synthesizes offline with on-demand Fargate and the given image tag', () => {
    expect(app.synth().manifest.missing ?? []).toEqual([]);
    stack.resourceCountIs('AWS::EC2::NatGateway', 0);
    stack.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
    });
    const [taskDef] = Object.values(stack.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDef.Properties.ContainerDefinitions).toHaveLength(1);
    expect(JSON.stringify(taskDef.Properties.ContainerDefinitions[0].Image)).toContain(':abc1234');
    expect(taskDef.Properties.ContainerDefinitions[0].Environment).toEqual(
      expect.arrayContaining([{ Name: 'EMAIL_BCC', Value: '' }]),
    );
  });

  test('forwards the viewer Host header and routes by host on the ALB', () => {
    const [dist] = Object.values(stack.findResources('AWS::CloudFront::Distribution'));
    const config = dist.Properties.DistributionConfig;
    expect(config.CustomErrorResponses).toBeUndefined();
    for (const behavior of config.CacheBehaviors) {
      expect(behavior.OriginRequestPolicyId).toBe(MANAGED_ALL_VIEWER_AND_CLOUDFRONT);
    }
    stack.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [Match.objectLike({ Field: 'host-header' })],
    });
  });

  test('Secrets Manager for TURNSTILESECRET and 30-day logs', () => {
    stack.resourceCountIs('AWS::SecretsManager::Secret', 1);
    stack.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });
});
