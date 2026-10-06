import { ScribeConfig, accountFromEnv, azsFor, regionFromEnv } from '../lib/config';

// Alex's personal AWS account: the low-cost `dev` profile (PRD §7.6).
// Account 821327748249 (local CLI profile `mybestday`); SCRIBE_ALEX_DEV_ACCOUNT overrides it.
const account = accountFromEnv('SCRIBE_ALEX_DEV_ACCOUNT', '821327748249');
const region = regionFromEnv('SCRIBE_ALEX_DEV_REGION');
const hostname = 'app.scrivenly.com';

const config: ScribeConfig = {
  name: 'alex-dev',
  profile: 'dev',
  account,
  region,
  availabilityZones: azsFor(region),

  hostname,
  createHostedZone: true,
  // HSTS max-age only. includeSubdomains/preload would reach other *.app.scrivenly.com
  // names and browsers' preload list; leave them off unless that's intended.
  hsts: { includeSubdomains: false, preload: false },

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
    // Dev deploys without an outage and marks a new task healthy in ~10 s
    overlapDeploys: true,
    healthCheckIntervalSeconds: 5,
  },

  ses: {
    domain: 'scrivenly.com',
    // scrivenly.com is already a verified SES identity in 821327748249 (set up 2026-10-04 for the
    // live site), so the stack must not create it again. Set SCRIBE_ALEX_DEV_CREATE_SES_IDENTITY=true
    // only for an account where it doesn't exist yet.
    createIdentity: process.env.SCRIBE_ALEX_DEV_CREATE_SES_IDENTITY === 'true',
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
    // No BCC in dev. Set SCRIBE_ALEX_DEV_EMAIL_BCC to get a copy of every email while testing.
    EMAIL_BCC: process.env.SCRIBE_ALEX_DEV_EMAIL_BCC ?? '',
    // Never the real announcement list in dev: approved announcements go to Alex.
    // SCRIBE_ALEX_DEV_ANNOUNCE_EMAIL_TO overrides it (set it to '' to disable sending).
    ANNOUNCE_EMAIL_TO: process.env.SCRIBE_ALEX_DEV_ANNOUNCE_EMAIL_TO ?? 'alexander.young@gmail.com',
    BOOTSTRAP_ADMIN_EMAILS: process.env.SCRIBE_ALEX_DEV_BOOTSTRAP_ADMIN_EMAILS || 'alexander.young@gmail.com',
    GOOGLE_CLIENT_ID: '402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg.apps.googleusercontent.com',
    // Merged real-time editing (Yjs, PRD §14) is on in dev; the Rangers environments keep the default 'legacy'.
    COLLAB_MODE: 'yjs',
  },

  // SSM SecureString you create by hand (infra/README.md, first-time setup).
  turnstileSecretName: '/scribe/alex-dev/TURNSTILESECRET',
};

export default config;
