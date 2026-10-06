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

/**
 * A stack-created ALB must be reachable only through CloudFront: no ingress from anywhere
 * (IPv4 or IPv6), exactly one rule (443) from the origin-facing managed prefix list, whose ID
 * a custom resource resolves at deploy time, and no port 80 listener.
 */
function expectAlbOnlyFromCloudFront(stack: Template): void {
  const groups = stack.findResources('AWS::EC2::SecurityGroup');
  const albGroupIds = Object.keys(groups).filter((id) => id.includes('AlbSecurityGroup'));
  expect(albGroupIds).toHaveLength(1);
  const [albGroupId] = albGroupIds;

  const inlineRules = (groups[albGroupId].Properties.SecurityGroupIngress ?? []) as Array<Record<string, unknown>>;
  const separateRules = Object.values(stack.findResources('AWS::EC2::SecurityGroupIngress'))
    .map((r) => r.Properties as Record<string, unknown>)
    .filter((p) => JSON.stringify(p.GroupId).includes(albGroupId));
  const rules = [...inlineRules, ...separateRules];

  for (const rule of rules) {
    expect(rule.CidrIp).not.toBe('0.0.0.0/0');
    expect(rule.CidrIpv6).not.toBe('::/0');
  }
  expect(JSON.stringify(rules)).not.toMatch(/0\.0\.0\.0\/0|::\/0/);

  expect(rules).toHaveLength(1);
  const [rule] = rules;
  expect(rule).toMatchObject({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 });
  expect(JSON.stringify(rule.SourcePrefixListId)).toContain('CloudFrontPrefixListLookup');

  const lookups = Object.values(stack.findResources('Custom::AWS'));
  expect(lookups).toHaveLength(1);
  const create = JSON.stringify(lookups[0].Properties.Create);
  expect(create).toContain('describeManagedPrefixLists');
  expect(create).toContain('com.amazonaws.global.cloudfront.origin-facing');

  const listeners = Object.values(stack.findResources('AWS::ElasticLoadBalancingV2::Listener'));
  expect(listeners.map((l) => l.Properties.Port)).toEqual([443]);
}

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

  test('turns on Yjs collaboration (COLLAB_MODE=yjs)', () => {
    const [taskDef] = Object.values(compute.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDef.Properties.ContainerDefinitions[0].Environment).toEqual(
      expect.arrayContaining([{ Name: 'COLLAB_MODE', Value: 'yjs' }]),
    );
  });

  test('lets sent announcements be resent (ALLOW_ANNOUNCEMENT_RESEND=true)', () => {
    const [taskDef] = Object.values(compute.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDef.Properties.ContainerDefinitions[0].Environment).toEqual(
      expect.arrayContaining([{ Name: 'ALLOW_ANNOUNCEMENT_RESEND', Value: 'true' }]),
    );
  });

  test('sends Comms Calendar nudges only to Alex (NUDGE_EMAIL_OVERRIDE)', () => {
    const [taskDef] = Object.values(compute.findResources('AWS::ECS::TaskDefinition'));
    expect(taskDef.Properties.ContainerDefinitions[0].Environment).toEqual(
      expect.arrayContaining([{ Name: 'NUDGE_EMAIL_OVERRIDE', Value: 'alexander.young@gmail.com' }]),
    );
  });

  test('service runs one task on FARGATE_SPOT only, with a public IP, overlapping 100%/200% deployments', () => {
    compute.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }],
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100, MaximumPercent: 200 }),
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }) },
    });
    persistent.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
      CapacityProviders: Match.arrayWith(['FARGATE_SPOT']),
    });
  });

  test('health checks every 5 s', () => {
    compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckIntervalSeconds: 5,
      HealthCheckTimeoutSeconds: 4,
      HealthyThresholdCount: 2,
    });
  });

  test('task security group only accepts traffic from the ALB', () => {
    const ingress = Object.values(compute.findResources('AWS::EC2::SecurityGroupIngress')).filter((r) =>
      JSON.stringify(r.Properties.GroupId).includes('TaskSecurityGroup'),
    );
    expect(ingress).toHaveLength(1);
    const [rule] = ingress;
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
  });

  test('ALB accepts only HTTPS from the CloudFront origin-facing prefix list', () => {
    expectAlbOnlyFromCloudFront(compute);
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
    expect(config.Origins.map((o: { DomainName: unknown }) => o.DomainName)).toContain('origin.app.scrivenly.com');
  });

  test('HSTS keeps a two-year max-age without includeSubdomains or preload', () => {
    persistent.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: false,
            Preload: false,
            Override: true,
          },
        }),
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
          Match.objectLike({ ExpiredObjectDeleteMarker: true, Status: 'Enabled' }),
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
    // Collaboration mode stays at the backend default (legacy) until it's turned on deliberately.
    expect(taskDef.Properties.ContainerDefinitions[0].Environment).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'COLLAB_MODE' })]),
    );
    // Announcements are sent once outside dev
    expect(taskDef.Properties.ContainerDefinitions[0].Environment).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'ALLOW_ANNOUNCEMENT_RESEND' })]),
    );
    // Nudges reach the real teams only in production
    const nudgeOverride = expect.arrayContaining([expect.objectContaining({ Name: 'NUDGE_EMAIL_OVERRIDE' })]);
    if (configName === 'rangers-production') {
      expect(taskDef.Properties.ContainerDefinitions[0].Environment).not.toEqual(nudgeOverride);
    } else {
      expect(taskDef.Properties.ContainerDefinitions[0].Environment).toEqual(nudgeOverride);
    }
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

  test('ALB accepts only HTTPS from the CloudFront origin-facing prefix list', () => {
    expectAlbOnlyFromCloudFront(stack);
  });

  if (configName === 'rangers-staging') {
    // Production runs older staging commit tags from this shared repository.
    test('ECR lifecycle keeps enough tagged images for production and rollback', () => {
      const [repo] = Object.values(stack.findResources('AWS::ECR::Repository'));
      const policy = JSON.parse(repo.Properties.LifecyclePolicy.LifecyclePolicyText);
      const tagged = policy.rules.find((r: any) => r.selection.tagStatus === 'tagged');
      expect(tagged.selection.countNumber).toBeGreaterThanOrEqual(100);
    });
  }

  test('HSTS defaults: max-age only, no includeSubdomains or preload', () => {
    stack.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 63072000, IncludeSubdomains: false, Preload: false }),
        }),
      }),
    });
  });

  test('data bucket removes expired delete markers', () => {
    stack.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpiredObjectDeleteMarker: true, Status: 'Enabled' })]),
      },
    });
  });

  test('Secrets Manager for TURNSTILESECRET and 30-day logs', () => {
    stack.resourceCountIs('AWS::SecretsManager::Secret', 1);
    stack.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });
});
