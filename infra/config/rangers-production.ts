import { ScribeConfig, accountFromEnv, azsFor, regionFromEnv } from '../lib/config';

// Ranger tech team's account, production: the `standard` profile (PRD §7.6, §9).
// Placeholders below are for the tech team to confirm (PRD §11). Set SCRIBE_RANGERS_ACCOUNT
// to the account ID before deploying.
const account = accountFromEnv('SCRIBE_RANGERS_ACCOUNT');
const region = regionFromEnv('SCRIBE_RANGERS_REGION');
const hostname = 'scrivenly.com'; // placeholder: final production hostname

const config: ScribeConfig = {
  name: 'rangers-production',
  profile: 'standard',
  account,
  region,
  availabilityZones: azsFor(region),

  hostname,
  // certificates: {
  //   cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:<account>:certificate/<id>',
  //   albCertificateArn: 'arn:aws:acm:<region>:<account>:certificate/<id>',
  // },

  buckets: {
    spa: `comms-scribe-rangers-production-spa-${account}`,
    data: `comms-scribe-rangers-production-data-${account}`,
  },

  // Imported: scribe-rangers-staging creates the repository. ranger-deploy promotes staging's
  // image (same repository) to production.
  ecr: { repositoryName: 'comms-scribe', create: false },

  ecs: {
    clusterName: 'scribe-rangers-production',
    serviceName: 'scribe-production',
    cpu: 512,
    memoryMiB: 1024,
  },

  // The identity is per account; scribe-rangers-staging creates it.
  ses: { domain: 'scrivenly.com', createIdentity: false },

  backendEnv: {
    PUBLIC_URL: `https://${hostname}/api`,
    FRONTEND_URL: `https://${hostname}`,
    SES_REGION: region,
    EMAIL_FROM: 'Comms Scribe <noreply@scrivenly.com>', // placeholder: confirm sender
    EMAIL_BCC: '', // must stay empty in Rangers environments
    ANNOUNCE_EMAIL_TO: 'rangers-announce@burningman.org',
    BOOTSTRAP_ADMIN_EMAILS: '', // placeholder: the first admin's email address
    GOOGLE_CLIENT_ID: '402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg.apps.googleusercontent.com',
  },

  turnstileSecretName: 'scribe/rangers-production/TURNSTILESECRET',

  // See rangers-staging.ts for the useExisting example.
};

export default config;
