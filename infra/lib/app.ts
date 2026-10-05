import { App, Environment, Tags } from 'aws-cdk-lib';
import alexDev from '../config/alex-dev';
import rangersProduction from '../config/rangers-production';
import rangersStaging from '../config/rangers-staging';
import { ScribeConfig, validateConfig } from './config';
import { DevComputeStack } from './dev-compute-stack';
import { DevPersistentStack } from './dev-persistent-stack';
import { StandardStack } from './standard-stack';

export const CONFIGS: Record<string, ScribeConfig> = {
  'alex-dev': alexDev,
  'rangers-staging': rangersStaging,
  'rangers-production': rangersProduction,
};

export const DEV_PERSISTENT_STACK = 'scribe-dev-persistent';
export const DEV_COMPUTE_STACK = 'scribe-dev-compute';

export function standardStackName(config: ScribeConfig): string {
  return `scribe-${config.name}`;
}

function parseDesiredCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1) {
    throw new Error(`desiredCount must be 0 or 1 (rooms and cache are in process memory), got "${value}"`);
  }
  return n;
}

/**
 * Builds the CDK app for one config. Used by bin/app.ts (context from the CLI) and the tests.
 *
 * Context keys:
 *   config        required: alex-dev | rangers-staging | rangers-production
 *   imageTag      required for standard configs: the currently deployed image tag (PRD §7.2)
 *   desiredCount  optional 0|1: 0 for a first standard deploy before any image exists
 */
export function buildApp(context: Record<string, unknown> = {}, app?: App): App {
  app ??= new App({ context });
  const configName = app.node.tryGetContext('config') as string | undefined;
  if (!configName || !CONFIGS[configName]) {
    throw new Error(
      `Pass a config with -c config=<name>. Known configs: ${Object.keys(CONFIGS).join(', ')}`,
    );
  }
  const config = CONFIGS[configName];
  validateConfig(config);

  const env: Environment = { account: config.account, region: config.region };
  const desiredCount = parseDesiredCount(app.node.tryGetContext('desiredCount'));
  Tags.of(app).add('app', 'comms-scribe');
  Tags.of(app).add('scribe-config', config.name);

  if (config.profile === 'dev') {
    new DevPersistentStack(app, DEV_PERSISTENT_STACK, config, {
      env,
      description: `Comms Scribe ${config.name}: always-on resources (buckets, ECR, CloudFront, DNS, cluster, IAM)`,
    });
    new DevComputeStack(app, DEV_COMPUTE_STACK, config, {
      env,
      desiredCount,
      description: `Comms Scribe ${config.name}: ALB and Fargate Spot service (exists only while awake)`,
    });
  } else {
    const imageTag = app.node.tryGetContext('imageTag') as string | undefined;
    if (!imageTag || !/^[A-Za-z0-9_.-]{1,128}$/.test(imageTag)) {
      throw new Error(
        `Standard config "${config.name}" needs -c imageTag=<currently deployed tag> (PRD §7.2: otherwise ` +
          'CloudFormation rolls back the image ranger-deploy deployed). Read it with:\n' +
          `  aws ecs describe-task-definition --task-definition "$(aws ecs describe-services --cluster ${config.ecs.clusterName} ` +
          `--services ${config.ecs.serviceName} --query 'services[0].taskDefinition' --output text)" ` +
          "--query 'taskDefinition.containerDefinitions[0].image' --output text",
      );
    }
    new StandardStack(app, standardStackName(config), config, {
      env,
      imageTag,
      desiredCount,
      description: `Comms Scribe ${config.name} (standard profile)`,
    });
  }
  return app;
}
