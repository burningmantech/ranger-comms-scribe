import { ScribeConfig, accountFromEnv, azsFor, regionFromEnv } from '../lib/config';

// Ranger tech team's account, staging: the `standard` profile (PRD §7.6, §9).
// Placeholders below are for the tech team to confirm (PRD §11). Set SCRIBE_RANGERS_ACCOUNT
// to the account ID before deploying.
const account = accountFromEnv('SCRIBE_RANGERS_ACCOUNT');
const region = regionFromEnv('SCRIBE_RANGERS_REGION');
const hostname = 'staging.scrivenly.com'; // placeholder: final staging hostname

const config: ScribeConfig = {
  name: 'rangers-staging',
  profile: 'standard',
  account,
  region,
  availabilityZones: azsFor(region),

  hostname,
  // HSTS max-age only (the defaults). Production decides about includeSubdomains/preload for
  // the parent domain; staging never should.
  hsts: { includeSubdomains: false, preload: false },
  // certificates: {
  //   cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:<account>:certificate/<id>',
  //   albCertificateArn: 'arn:aws:acm:<region>:<account>:certificate/<id>',
  // },

  buckets: {
    spa: `comms-scribe-rangers-staging-spa-${account}`,
    data: `comms-scribe-rangers-staging-data-${account}`,
  },

  // Staging owns the shared ECR repository; production imports it.
  ecr: { repositoryName: 'comms-scribe', create: true },

  ecs: {
    clusterName: 'scribe-rangers-staging',
    serviceName: 'scribe-staging',
    cpu: 512,
    memoryMiB: 1024,
  },

  // Staging owns the per-account SES identity; production relies on it.
  // Set false to use an identity that already exists in the account (PRD §11, question 5).
  ses: { domain: 'scrivenly.com', createIdentity: true },

  backendEnv: {
    PUBLIC_URL: `https://${hostname}/api`,
    FRONTEND_URL: `https://${hostname}`,
    SES_REGION: region,
    EMAIL_FROM: 'Comms Scribe <noreply@scrivenly.com>', // placeholder: confirm sender
    EMAIL_BCC: '', // must stay empty in Rangers environments
    ANNOUNCE_EMAIL_TO: '', // staging must not email the real list; set a test list if needed
    NUDGE_EMAIL_OVERRIDE: 'noreply@scrivenly.com', // placeholder: staging must not email real teams; set a test address
    COMMS_EMAIL_OVERRIDE: 'noreply@scrivenly.com', // placeholder: staging must not email real lists or approvers
    BOOTSTRAP_ADMIN_EMAILS: '', // placeholder: the first admin's email address
    GOOGLE_CLIENT_ID: '402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg.apps.googleusercontent.com',
  },

  // Secrets Manager secret created by the stack; set its value after the first deploy.
  turnstileSecretName: 'scribe/rangers-staging/TURNSTILESECRET',

  // To use the tech team's existing network, cluster and shared ALB (PRD §11, question 2).
  // Setting this makes synth look up the VPC, so it then needs AWS credentials.
  // useExisting: {
  //   vpcId: 'vpc-xxxxxxxx',
  //   clusterName: 'rangers',
  //   albListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:<account>:listener/app/<alb>/<id>/<id>',
  //   albSecurityGroupId: 'sg-xxxxxxxx',
  //   albDnsName: 'internal-or-public-alb-name.us-east-1.elb.amazonaws.com',
  // },
};

export default config;
