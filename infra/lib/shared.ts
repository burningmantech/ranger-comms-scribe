import {
  Duration,
  RemovalPolicy,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_s3 as s3,
  aws_ses as ses,
  CfnOutput,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScribeConfig } from './config';

/** Dev resources are disposable (PRD Phase 4: destroy both stacks and redeploy); standard keeps data. */
export function removalPolicyFor(config: ScribeConfig): RemovalPolicy {
  return config.profile === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
}

/** Key prefixes of short-lived objects (see backend/src/handlers/auth.ts, utils/sessionManager.ts). */
export const EPHEMERAL_PREFIXES = ['session/', 'verification-token/', 'reset-token/'];

export function createDataBucket(scope: Construct, config: ScribeConfig): s3.Bucket {
  const removalPolicy = removalPolicyFor(config);
  return new s3.Bucket(scope, 'DataBucket', {
    bucketName: config.buckets.data,
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy,
    autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
    lifecycleRules: [
      ...EPHEMERAL_PREFIXES.map((prefix) => ({
        id: `expire-${prefix.replace(/\/$/, '')}`,
        prefix,
        expiration: Duration.days(14),
      })),
      {
        id: 'expire-noncurrent-versions',
        noncurrentVersionExpiration: Duration.days(30),
        abortIncompleteMultipartUploadAfter: Duration.days(7),
      },
      // Deletes and the expiry rules above leave delete markers; once their noncurrent
      // versions expire they're "expired object delete markers" and only slow down listings.
      // (S3 rejects this flag in a rule that also sets `expiration`, hence its own rule.)
      {
        id: 'remove-expired-delete-markers',
        expiredObjectDeleteMarker: true,
      },
    ],
  });
}

export function createSpaBucket(scope: Construct, config: ScribeConfig): s3.Bucket {
  const removalPolicy = removalPolicyFor(config);
  return new s3.Bucket(scope, 'SpaBucket', {
    bucketName: config.buckets.spa,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy,
    autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
  });
}

/** ECR repository (created or imported by name). */
export function repositoryFor(scope: Construct, config: ScribeConfig): ecr.IRepository {
  if (!config.ecr.create) {
    return ecr.Repository.fromRepositoryName(scope, 'Repository', config.ecr.repositoryName);
  }
  const removalPolicy = removalPolicyFor(config);
  // Dev only runs `:dev`. In the standard profile ranger-deploy tags every master
  // push with its commit ID and production reuses an older staging tag from this
  // same repository, so a small count would expire the image production runs
  // (breaking task replacement and rollback).
  const keepTagged = config.profile === 'dev' ? 10 : 200;
  return new ecr.Repository(scope, 'Repository', {
    repositoryName: config.ecr.repositoryName,
    imageScanOnPush: true,
    removalPolicy,
    emptyOnDelete: removalPolicy === RemovalPolicy.DESTROY,
    lifecycleRules: [
      // Untagged images (superseded `:dev` pushes, failed builds) go after a day.
      { rulePriority: 1, description: 'Expire untagged images', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(1) },
      {
        rulePriority: 2,
        description: `Keep the last ${keepTagged} tagged images`,
        tagStatus: ecr.TagStatus.TAGGED,
        tagPatternList: ['*'],
        maxImageCount: keepTagged,
      },
    ],
  });
}

/** Stack-created VPC: public subnets only, no NAT, free S3 gateway endpoint (PRD §6 Network). */
export function createVpc(scope: Construct, config: ScribeConfig): ec2.Vpc {
  return new ec2.Vpc(scope, 'Vpc', {
    ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
    availabilityZones: config.availabilityZones,
    natGateways: 0,
    subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    gatewayEndpoints: {
      S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
    },
  });
}

/** Task role policy: data bucket read/write and SES sending (no static keys). */
export function grantTaskRole(role: iam.IRole, dataBucket: s3.IBucket): void {
  dataBucket.grantReadWrite(role);
  // Resource `*`: in SES sandbox mode recipient identities are authorized too, not only the sender.
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }),
  );
}

/** Container environment (contracts §3), excluding TURNSTILESECRET which goes through `secrets`. */
export function backendEnvironment(config: ScribeConfig): Record<string, string> {
  const env: Record<string, string> = {
    PORT: '8080',
    DATA_BUCKET: config.buckets.data,
    AWS_REGION: config.backendEnv.AWS_REGION ?? config.region,
    PUBLIC_URL: config.backendEnv.PUBLIC_URL,
    FRONTEND_URL: config.backendEnv.FRONTEND_URL,
    SES_REGION: config.backendEnv.SES_REGION,
    EMAIL_FROM: config.backendEnv.EMAIL_FROM,
    EMAIL_BCC: config.backendEnv.EMAIL_BCC,
    ANNOUNCE_EMAIL_TO: config.backendEnv.ANNOUNCE_EMAIL_TO,
    BOOTSTRAP_ADMIN_EMAILS: config.backendEnv.BOOTSTRAP_ADMIN_EMAILS,
    GOOGLE_CLIENT_ID: config.backendEnv.GOOGLE_CLIENT_ID,
  };
  if (config.backendEnv.CORS_ORIGINS) env.CORS_ORIGINS = config.backendEnv.CORS_ORIGINS;
  // Optional; the backend defaults (25 MiB, 16 MiB) apply when unset.
  if (config.backendEnv.MAX_BODY_BYTES) env.MAX_BODY_BYTES = config.backendEnv.MAX_BODY_BYTES;
  if (config.backendEnv.WS_MAX_PAYLOAD_BYTES) env.WS_MAX_PAYLOAD_BYTES = config.backendEnv.WS_MAX_PAYLOAD_BYTES;
  // Optional; the backend default is 'legacy' (whole-document sync).
  if (config.backendEnv.COLLAB_MODE) env.COLLAB_MODE = config.backendEnv.COLLAB_MODE;
  if (config.backendEnv.ALLOW_ANNOUNCEMENT_RESEND) env.ALLOW_ANNOUNCEMENT_RESEND = config.backendEnv.ALLOW_ANNOUNCEMENT_RESEND;
  if (config.backendEnv.NUDGE_EMAIL_OVERRIDE) env.NUDGE_EMAIL_OVERRIDE = config.backendEnv.NUDGE_EMAIL_OVERRIDE;
  return env;
}

/** Rewrites extensionless paths to /index.html (SPA deep links) without touching API errors. */
const SPA_REWRITE_CODE = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
`.trim();

export interface DistributionProps {
  config: ScribeConfig;
  spaBucket: s3.IBucket;
  /** DNS name CloudFront connects to over HTTPS for /api/*. */
  apiOriginDomain: string;
  certificate: acm.ICertificate;
  /** Standard profile: forward the viewer Host header for the shared ALB's host rules. */
  forwardViewerHost: boolean;
}

export function createDistribution(scope: Construct, props: DistributionProps): cloudfront.Distribution {
  const { config, spaBucket, apiOriginDomain, certificate, forwardViewerHost } = props;

  const hsts = new cloudfront.ResponseHeadersPolicy(scope, 'SecurityHeaders', {
    comment: `HSTS and basic security headers for ${config.hostname}`,
    securityHeadersBehavior: {
      strictTransportSecurity: {
        accessControlMaxAge: Duration.seconds(63072000),
        // Opt-in per config (ScribeConfig.hsts): on a bare domain these reach every subdomain
        // and the browsers' preload list.
        includeSubdomains: config.hsts?.includeSubdomains ?? false,
        preload: config.hsts?.preload ?? false,
        override: true,
      },
      contentTypeOptions: { override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: false },
    },
  });

  const spaRewrite = new cloudfront.Function(scope, 'SpaRewrite', {
    comment: 'Rewrite extensionless paths to /index.html',
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    code: cloudfront.FunctionCode.fromInline(SPA_REWRITE_CODE),
  });

  const apiOrigin = new origins.HttpOrigin(apiOriginDomain, {
    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    readTimeout: Duration.seconds(60),
    keepaliveTimeout: Duration.seconds(60),
  });

  const originRequestPolicy = forwardViewerHost
    ? cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022
    : cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

  // Gallery: only responses that send Cache-Control are cached (default TTL 0), up to the backend's
  // one-year max-age. Authorization is in the cache key so authenticated gallery routes
  // (list, metadata, comments) are never shared between users.
  const galleryCachePolicy = new cloudfront.CachePolicy(scope, 'GalleryCachePolicy', {
    comment: 'Gallery: honour origin Cache-Control, key on Authorization and query strings',
    defaultTtl: Duration.seconds(0),
    minTtl: Duration.seconds(0),
    maxTtl: Duration.days(365),
    headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  });

  return new cloudfront.Distribution(scope, 'Distribution', {
    comment: `Comms Scribe ${config.name}`,
    domainNames: [config.hostname],
    certificate,
    defaultRootObject: 'index.html',
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    // No errorResponses: they apply distribution-wide and would turn API 403/404 into index.html.
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(spaBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: hsts,
      compress: true,
      functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    },
    // Order matters: CloudFront evaluates behaviors in this order, so gallery precedes /api/*.
    additionalBehaviors: {
      '/api/gallery/*': {
        origin: apiOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: galleryCachePolicy,
        originRequestPolicy,
        responseHeadersPolicy: hsts,
        compress: true,
      },
      '/api/*': {
        origin: apiOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // CachingDisabled + all-viewer-headers forwards Authorization, every query string
        // (WebSockets use ?sessionId=) and the WebSocket upgrade headers.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy,
        responseHeadersPolicy: hsts,
        compress: false,
      },
    },
  });
}

/** SES domain identity with its DKIM CNAMEs as outputs (add them where the domain's DNS lives). */
export function createSesIdentity(scope: Construct, config: ScribeConfig): void {
  if (!config.ses.createIdentity) return;
  const identity = new ses.EmailIdentity(scope, 'SesIdentity', {
    identity: ses.Identity.domain(config.ses.domain),
  });
  identity.dkimRecords.forEach((record, i) => {
    new CfnOutput(scope, `SesDkimRecord${i + 1}`, {
      description: `SES DKIM CNAME ${i + 1} for ${config.ses.domain}: name => value`,
      value: `${record.name} CNAME ${record.value}`,
    });
  });
}
