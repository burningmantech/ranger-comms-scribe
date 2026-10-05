/**
 * Per-environment configuration for the Comms Scribe CDK app.
 *
 * One file per environment lives in `infra/config/`. Select it with
 * `cdk synth -c config=<name>` (see infra/README.md).
 */

export type Profile = 'dev' | 'standard';

/** Backend environment variables (contracts §3). DATA_BUCKET and PORT are filled in by the stack. */
export interface BackendEnv {
  PUBLIC_URL: string;
  FRONTEND_URL: string;
  /** Comma-separated. Omit to use the backend default (FRONTEND_URL plus http://localhost:3000). */
  CORS_ORIGINS?: string;
  AWS_REGION?: string;
  SES_REGION: string;
  EMAIL_FROM: string;
  /** Comma-separated. Must be empty in Rangers environments. */
  EMAIL_BCC: string;
  /** Announcement list for approved submissions. Empty disables sending (use a test list outside production). */
  ANNOUNCE_EMAIL_TO: string;
  /** Comma-separated, case-insensitive. */
  BOOTSTRAP_ADMIN_EMAILS: string;
  GOOGLE_CLIENT_ID: string;
  /** Largest HTTP request body in bytes. Omit for the backend default (25 MiB). */
  MAX_BODY_BYTES?: string;
  /** Largest WebSocket message in bytes. Omit for the backend default (16 MiB). */
  WS_MAX_PAYLOAD_BYTES?: string;
}

export interface UseExisting {
  /** Imported with `Vpc.fromLookup`, so synth needs AWS credentials when this is set. */
  vpcId: string;
  clusterName: string;
  /**
   * HTTPS listener on a shared ALB. When set, the stack adds a host-header rule to it instead
   * of creating its own ALB. Requires `albSecurityGroupId` and `albDnsName`.
   */
  albListenerArn?: string;
  /** Security group of the shared ALB (the task security group allows inbound from it). */
  albSecurityGroupId?: string;
  /** DNS name CloudFront uses to reach the shared ALB (the ALB's own name or a CNAME to it). */
  albDnsName?: string;
  /** Priority of the host-header rule on the shared listener (must be unique there). Default 100. */
  albRulePriority?: number;
}

export interface ScribeConfig {
  /** Config name, e.g. `alex-dev`. Used in resource names and the SSM prefix. */
  name: string;
  profile: Profile;
  account: string;
  region: string;
  /**
   * Explicit AZs so `cdk synth` never needs an AZ context lookup (it must work offline).
   * Two are enough: the ALB needs at least two.
   */
  availabilityZones: string[];

  /** Public hostname served by CloudFront, e.g. `aws-dev.scrivenly.com`. */
  hostname: string;
  /**
   * Dev only: create a Route 53 public hosted zone for `hostname` (delegated from Cloudflare by
   * NS records). It holds the CloudFront alias, `origin.<hostname>` and ACM validation records.
   */
  createHostedZone?: boolean;
  /**
   * Existing certificates. When omitted the stack creates DNS-validated ones: in the hosted zone
   * (dev), or with manual DNS validation (standard; CloudFormation waits until the CNAMEs exist).
   */
  certificates?: {
    /** Must be in us-east-1. */
    cloudFrontCertificateArn?: string;
    /** Regional, for the ALB listener. Must cover `hostname` (standard forwards the Host header). */
    albCertificateArn?: string;
  };

  buckets: {
    spa: string;
    data: string;
  };

  ecr: {
    repositoryName: string;
    /**
     * Create the repository in this stack. ECR names are per-account, so in an account that
     * hosts both staging and production only one stack creates it and the other imports it.
     */
    create: boolean;
  };

  ecs: {
    clusterName: string;
    serviceName: string;
    /** Fargate CPU units (256 = 0.25 vCPU). */
    cpu: number;
    memoryMiB: number;
  };

  ses: {
    /** Domain identity used for EMAIL_FROM. */
    domain: string;
    /** Creating it fails if the identity already exists in the account, so this is opt-in. */
    createIdentity: boolean;
  };

  /** Dev only: AWS Budgets alert. */
  budget?: {
    monthlyLimitUsd: number;
    alertEmail: string;
  };

  backendEnv: BackendEnv;

  /**
   * TURNSTILESECRET source. Dev: name of an SSM SecureString parameter that you create by hand.
   * Standard: name of a Secrets Manager secret the stack creates (you set its value).
   */
  turnstileSecretName: string;

  useExisting?: UseExisting;
}

/** Where the dev persistent stack publishes values for the compute stack and the bin/ scripts. */
export function ssmPrefix(config: ScribeConfig): string {
  return `/scribe/${config.name}`;
}

export function logRetentionDays(config: ScribeConfig): number {
  return config.profile === 'dev' ? 7 : 30;
}

/** Placeholder used when no account override is set; deploys to it fail safely (credential mismatch). */
export const PLACEHOLDER_ACCOUNT = '000000000000';

export function accountFromEnv(varName: string): string {
  const value = process.env[varName];
  if (value && !/^\d{12}$/.test(value)) {
    throw new Error(`${varName} must be a 12-digit AWS account ID, got "${value}"`);
  }
  return value || PLACEHOLDER_ACCOUNT;
}

export function regionFromEnv(varName: string, fallback = 'us-east-1'): string {
  return process.env[varName] || fallback;
}

export function azsFor(region: string): string[] {
  return [`${region}a`, `${region}b`];
}

export function validateConfig(config: ScribeConfig): void {
  const problems: string[] = [];
  if (config.availabilityZones.length < 2) problems.push('availabilityZones needs at least two entries (ALB requirement)');
  if (config.profile === 'dev') {
    if (!config.createHostedZone) problems.push('dev profile expects createHostedZone: true');
    if (!config.budget) problems.push('dev profile expects a budget');
    if (config.useExisting) problems.push('useExisting is only supported in the standard profile');
  }
  if (config.region !== 'us-east-1' && !config.certificates?.cloudFrontCertificateArn) {
    problems.push('outside us-east-1 you must supply certificates.cloudFrontCertificateArn (CloudFront certs live in us-east-1)');
  }
  const ue = config.useExisting;
  if (ue?.albListenerArn && (!ue.albSecurityGroupId || !ue.albDnsName)) {
    problems.push('useExisting.albListenerArn also needs albSecurityGroupId and albDnsName');
  }
  if (problems.length) {
    throw new Error(`Invalid config "${config.name}":\n  - ${problems.join('\n  - ')}`);
  }
}
