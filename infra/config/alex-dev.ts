import { ScribeConfig, accountFromEnv, azsFor, regionFromEnv } from '../lib/config';

// Alex's personal AWS account: the low-cost `dev` profile (PRD §7.6).
// Set SCRIBE_ALEX_DEV_ACCOUNT to the 12-digit account ID before deploying.
const account = accountFromEnv('SCRIBE_ALEX_DEV_ACCOUNT');
const region = regionFromEnv('SCRIBE_ALEX_DEV_REGION');
const hostname = 'aws-dev.scrivenly.com';

const config: ScribeConfig = {
  name: 'alex-dev',
  profile: 'dev',
  account,
  region,
  availabilityZones: azsFor(region),

  hostname,
  createHostedZone: true,

  buckets: {
    spa: `comms-scribe-alex-dev-spa-${account}`,
    data: `comms-scribe-alex-dev-data-${account}`,
  },

  ecr: { repositoryName: 'comms-scribe', create: true },

  ecs: {
    clusterName: 'scribe-dev',
    serviceName: 'scribe-dev',
    cpu: 256,
    memoryMiB: 512,
  },

  ses: {
    domain: 'scrivenly.com',
    // Set SCRIBE_ALEX_DEV_CREATE_SES_IDENTITY=false if scrivenly.com is already verified in the account.
    createIdentity: process.env.SCRIBE_ALEX_DEV_CREATE_SES_IDENTITY !== 'false',
  },

  budget: {
    monthlyLimitUsd: 15,
    alertEmail: process.env.SCRIBE_ALEX_DEV_BUDGET_EMAIL || 'alexander.young@gmail.com',
  },

  backendEnv: {
    PUBLIC_URL: `https://${hostname}/api`,
    FRONTEND_URL: `https://${hostname}`,
    SES_REGION: region,
    EMAIL_FROM: 'Comms Scribe <alex@scrivenly.com>',
    // Keeps today's behaviour (backend/src/utils/email.ts BCCs this address). In SES sandbox mode
    // the BCC address must be a verified identity too.
    EMAIL_BCC: process.env.SCRIBE_ALEX_DEV_EMAIL_BCC ?? 'alexander.young@gmail.com',
    // Never the real announcement list in dev; set a test address to try the send-email flow.
    ANNOUNCE_EMAIL_TO: process.env.SCRIBE_ALEX_DEV_ANNOUNCE_EMAIL_TO ?? '',
    BOOTSTRAP_ADMIN_EMAILS: process.env.SCRIBE_ALEX_DEV_BOOTSTRAP_ADMIN_EMAILS || 'alexander.young@gmail.com',
    GOOGLE_CLIENT_ID: '402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg.apps.googleusercontent.com',
  },

  // SSM SecureString you create by hand (infra/README.md, first-time setup).
  turnstileSecretName: '/scribe/alex-dev/TURNSTILESECRET',
};

export default config;
