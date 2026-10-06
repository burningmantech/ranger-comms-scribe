# Comms Scribe infrastructure (AWS CDK)

This directory is the AWS CDK v2 (TypeScript) app for Comms Scribe on AWS. One codebase serves two
**profiles**, selected per environment by a config file in `config/`:

| Config | Profile | Stacks | Where |
|---|---|---|---|
| `alex-dev` | `dev` | `scribe-dev-persistent`, `scribe-dev-compute` | Alex's AWS account |
| `rangers-staging` | `standard` | `scribe-rangers-staging` | Ranger tech team's account |
| `rangers-production` | `standard` | `scribe-rangers-production` | Ranger tech team's account |

The spec is `docs/plans/2026-10-04-aws-migration-prd.md` (§6, §7, Phase 3). The shared interfaces are in
`docs/plans/2026-10-04-aws-migration-contracts.md`.

## Commands

```sh
cd infra
npm ci
npx tsc --noEmit                    # type check
npx jest                            # synth assertions (no NAT, one container, FARGATE_SPOT, ...)

npx cdk synth -c config=alex-dev
npx cdk synth -c config=rangers-staging    -c imageTag=<tag>
npx cdk synth -c config=rangers-production -c imageTag=<tag>
```

- **`-c config=<name>` is required.** There's no default, so you can't deploy the wrong environment by accident.
- **Synth works offline**, with no AWS credentials. Accounts come from config (see below), AZs are explicit, and nothing uses
  `fromLookup` unless `useExisting` is set.
- **Accounts.** Each config reads its account ID from an environment variable: `SCRIBE_ALEX_DEV_ACCOUNT` or `SCRIBE_RANGERS_ACCOUNT`.
  - Without the variable, the account is the placeholder `000000000000`. That synths fine, and a deploy fails safely because the
    credentials don't match the account.
  - Regions default to `us-east-1`. Override with `SCRIBE_ALEX_DEV_REGION` or `SCRIBE_RANGERS_REGION`.
- Optional context: `-c desiredCount=0|1`. Use `0` for a first standard deploy before an image exists (see the handoff notes).

## What the profiles share and where they differ

Both profiles have the same shape (PRD §6):

- **CloudFront** with three behaviors:
  - **default →** the SPA bucket, through OAC. A CloudFront Function rewrites extensionless paths to `/index.html`.
  - **`/api/gallery/*` →** the API origin, cached. It honours the origin's `Cache-Control`; responses without one aren't
    cached. `Authorization` and query strings are part of the cache key.
  - **`/api/*` →** the API origin, not cached. Every viewer header (including `Authorization` and the WebSocket upgrade
    headers) and every query string is forwarded.
  - There's an HSTS response-headers policy and **no custom error responses**, so API 403s and 404s reach the browser
    unchanged.
- **ALB** with a 120 s idle timeout and an HTTPS listener, reachable only from CloudFront (see "ALB ingress" below). The
  target group health-checks `GET /healthz` on port 8080.
- **Fargate service:**
  - `desiredCount` 1;
  - minimum healthy 0% / maximum 100%, so two tasks never run with split rooms;
  - deployment circuit breaker with rollback.
- **Task definition** with exactly one container (ranger-deploy's requirement):
  - linux/amd64;
  - environment variables from config (contracts §3), plus `PORT=8080`, `DATA_BUCKET` and `AWS_REGION`;
  - `TURNSTILESECRET` through `secrets`;
  - awslogs logging.
- **Task security group:** inbound only from the ALB's security group.
- **Data bucket:**
  - versioned;
  - `session/`, `verification-token/` and `reset-token/` expire after 14 days;
  - noncurrent versions expire after 30 days;
  - expired object delete markers are removed;
  - public access blocked, SSL enforced.
- **ECR repository** `comms-scribe`: untagged images expire after 1 day; the last 10 tagged images are kept.
- **Task role:** read/write on the data bucket, plus `ses:SendEmail` and `ses:SendRawEmail`. No static keys.
- **SES domain identity** for `scrivenly.com`, with the DKIM CNAMEs as stack outputs (optional per config).

Where they differ:

| | `dev` (alex-dev) | `standard` (rangers-*) |
|---|---|---|
| Stacks | `scribe-dev-persistent` (always on) and `scribe-dev-compute` (only while awake) | One stack per environment, always on |
| Capacity | `FARGATE_SPOT` only, 0.25 vCPU / 0.5 GB | `FARGATE` (on-demand), 0.5 vCPU / 1 GB placeholder |
| Network | Stack VPC: 2 public subnets, **no NAT**, S3 gateway endpoint, task public IP | Stack VPC (same shape), or `useExisting` VPC with private subnets |
| ALB | Own ALB, created on wake; forwards everything to the service | Own ALB with a host-header rule and a 404 default, or a rule on a shared listener (`useExisting.albListenerArn`) |
| CloudFront → ALB | `origin.app.scrivenly.com` over HTTPS; viewer `Host` **not** forwarded | ALB DNS name over HTTPS; viewer `Host` **forwarded** for host rules |
| DNS | Route 53 zone `app.scrivenly.com` (delegated from Cloudflare); ACM validated automatically | No zone. Point the hostname at CloudFront yourself; ACM validated manually or bring ARNs |
| `TURNSTILESECRET` | SSM SecureString you create by hand (free) | Secrets Manager secret the stack creates; you set its value |
| Logs | 7 days | 30 days |
| Image tag | Fixed `:dev` | Commit ID, passed to CDK with `-c imageTag` |
| Deploys | `bin/dev-deploy` from a laptop | GitHub Actions (`cicd.yml` → staging, `deploy.yml` → production) |
| Removal | Everything is destroyed with its stack (buckets emptied) | Buckets, repository, logs and secret are retained |
| Cost guardrail | AWS Budgets: $15/month, email at 80% actual and 100% forecast | The tech team's normal monitoring |

### How the dev stacks are split

`scribe-dev-persistent` holds everything that's cheap at rest:

- the SPA and data buckets, the ECR repository and CloudFront;
- the Route 53 zone, the CloudFront certificate, and the regional ALB certificate for `origin.app.scrivenly.com` and
  `app.scrivenly.com`;
- the VPC, the ECS cluster with the Fargate capacity providers, and the IAM roles;
- the log group, the SES identity and the budget.

`scribe-dev-compute` holds the ALB, listeners, target group, service, task definition, task security group and the
`origin.app.scrivenly.com` alias.

**The stacks share no CloudFormation exports.** The persistent stack publishes the values the compute stack and scripts need
as SSM parameters under `/scribe/alex-dev/`:

- `vpc-id` and `public-subnet-<n>`;
- `hosted-zone-id` and `alb-certificate-arn`;
- `cluster-name`, `service-name` and `ecr-repository-uri`;
- `spa-bucket` and `distribution-id`.

Everything else uses deterministic names: the cluster, the `comms-scribe` repository, the `/ecs/scribe-alex-dev` log group, and
the `scribe-alex-dev-task` and `scribe-alex-dev-execution` roles. So the compute stack can be destroyed and recreated at any
time, and CloudFront never changes on wake or sleep. Because the compute stack imports the roles as immutable, all their
grants live in the persistent stack.

## First-time setup in Alex's account (PRD Phase 4)

Prerequisites:

- AWS CLI v2 with a profile for the account;
- Node 24 (LTS) or later;
- Docker (Docker Desktop on macOS);
- Python 3, used by ranger-deploy.

```sh
export AWS_PROFILE=mybestday   # the local profile for account 821327748249
cd infra && npm ci
```

`alex-dev` defaults to account 821327748249 (override with `SCRIBE_ALEX_DEV_ACCOUNT`).

1. **Bootstrap CDK** (once per account and region):
   ```sh
   npx cdk bootstrap "aws://821327748249/us-east-1" -c config=alex-dev
   ```
2. **Deploy the persistent stack:**
   ```sh
   npx cdk deploy scribe-dev-persistent -c config=alex-dev
   ```
   - `scrivenly.com` is already a verified SES identity in 821327748249, so `alex-dev` doesn't create it. For an
     account where it doesn't exist yet, set `SCRIBE_ALEX_DEV_CREATE_SES_IDENTITY=true`.
   - The deploy **pauses at the ACM certificates** until step 3 is done. Their DNS validation records go into the new zone,
     and nothing resolves until Cloudflare delegates to it.
3. **Delegate `app.scrivenly.com` from Cloudflare.** While step 2 is still waiting, read the zone's name servers in
   another terminal:
   ```sh
   zone_id="$(aws route53 list-hosted-zones-by-name --dns-name app.scrivenly.com \
     --query 'HostedZones[0].Id' --output text)"
   aws route53 get-hosted-zone --id "${zone_id}" --query 'DelegationSet.NameServers' --output text
   ```
   In the Cloudflare `scrivenly.com` zone, add one `NS` record named `app` for each of the four name servers. The deploy
   then finishes within a few minutes. The name servers are also in the `HostedZoneNameServers` output.
4. **SES DKIM.** *Already done in 821327748249* (the identity and its DKIM records were set up on 2026-10-04, and the
   account is out of the SES sandbox). Only for an account where the stack creates the identity:
   - Add the three `SesDkimRecord*` outputs (`<token>._domainkey.scrivenly.com CNAME <token>.dkim.amazonses.com`) to the
     Cloudflare zone as **DNS-only** (not proxied) CNAMEs.
   - In SES sandbox mode, also verify every recipient you'll test with, including the `EMAIL_BCC` address:
     ```sh
     aws sesv2 create-email-identity --email-identity you@example.com
     ```
5. **Create the Turnstile secret** (it's never in git or CDK):
   ```sh
   read -rs -p 'Turnstile secret key: ' T; echo
   aws ssm put-parameter --type SecureString --name /scribe/alex-dev/TURNSTILESECRET --value "$T"; unset T
   ```
6. **Google OAuth.** Add `https://app.scrivenly.com` to the authorized JavaScript origins of the OAuth client
   `402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg`.
7. **Turnstile.** Add `app.scrivenly.com` to the widget's allowed hostnames.
8. **Wake and deploy:**
   ```sh
   bin/dev-up       # ~5 min; pushes a first :dev image if the repository is empty
   bin/dev-deploy   # backend through ranger-deploy (deploy_aws_ecs staging, :dev), then the frontend
   ```
9. **Sign in.** Sign in with Google using an address in `BOOTSTRAP_ADMIN_EMAILS` (`alexander.young@gmail.com` by default).
   A password registration is promoted only when its email is verified (SES must be able to send to it); that clears
   its password and sessions, so then set a password with "forgot password". Then
   create users, groups and council and cadre roles through the UI.

Backend settings for alex-dev are in `config/alex-dev.ts`. Some can be overridden at deploy time with environment variables:

- `SCRIBE_ALEX_DEV_EMAIL_BCC`
- `SCRIBE_ALEX_DEV_BOOTSTRAP_ADMIN_EMAILS`
- `SCRIBE_ALEX_DEV_BUDGET_EMAIL`

## Waking, sleeping and deploying dev

All scripts need `SCRIBE_ALEX_DEV_ACCOUNT`, and `AWS_PROFILE` if you use one. They refuse to run when the credentials belong
to a different account, and each prints its plan before acting. To skip setting them each time, put them in
`~/.config/comms-scribe/dev.env` as `KEY=value` lines (e.g. `AWS_PROFILE=mybestday`); the environment wins over the file.

| Command | What it does |
|---|---|
| `bin/dev-up` | Checks the Turnstile parameter, pushes a first `:dev` image if none exists, then runs `cdk deploy scribe-dev-compute --exclusively`. About 5 minutes. |
| `bin/dev-down` | `cdk destroy scribe-dev-compute --exclusively`. The ALB, task and their public IPv4 addresses go away; data stays in S3. |
| `bin/dev-deploy` | Builds `comms-scribe:local` (linux/amd64), then runs `bin/deploy staging` with `CI=true`, `AWS_ECR_IMAGE_NAME=<repo>:dev` and the dev cluster and service, and forces a new ECS deployment. The frontend builds alongside and is published (`bin/publish-frontend`) once the new task has taken over. A half whose files haven't changed since its last deploy from this machine is skipped (fingerprints in `~/.cache/comms-scribe/`). About 2–3 minutes for both. |
| `bin/dev-deploy --all` / `--backend-only` / `--frontend-only` | Both halves regardless of changes (e.g. after a deploy from elsewhere), or just one. |

**No outage on dev deploys.** Dev sets `overlapDeploys` (ECS min 100% / max 200%) and 5-second health checks
(`infra/config/alex-dev.ts`): the new task starts beside the old one, traffic moves once it passes two checks, and the old
task drains for 10 seconds and stops. For those seconds two tasks run, each with its own rooms and cache; clients of the old
one reconnect to the new one, as after any restart. Staging and production still stop the old task first (about 2 minutes
with no backend), as PRD §7.2 specifies.

While asleep, `https://app.scrivenly.com` still serves the SPA, and `/api/*` returns CloudFront 502s until `bin/dev-up`.

**Why `dev-deploy` forces a deployment.** ranger-deploy compares the new task definition with the current one. With a fixed
`:dev` tag they're identical after the first deploy, so it logs "Image name is unchanged. Nothing to deploy." and doesn't roll
the service. The image is still pushed. `aws ecs update-service --force-new-deployment` then starts a task that pulls it.

## Image-tag rules (PRD §7.2)

**CDK owns the task definition's structure and environment variables. ranger-deploy only swaps the image.** Don't use
`deploy_aws_ecs environment` on these services, because the next `cdk deploy` would revert it.

- **Dev:** always `<repo>:dev`, in CDK (`DEV_IMAGE_TAG`) and in `bin/dev-deploy`. CDK and ranger-deploy therefore always agree,
  and waking dev runs the latest pushed `:dev`.
- **Standard:**
  - ranger-deploy tags images with the 7-character commit ID, because `AWS_ECR_IMAGE_NAME` has no tag.
  - **Every `cdk deploy` must pass the currently deployed tag** as `-c imageTag=<tag>`; otherwise CloudFormation rolls the
    image back. Synth fails without it. Read the current tag with:
    ```sh
    aws ecs describe-task-definition --task-definition "$(aws ecs describe-services --cluster <cluster> \
      --services <service> --query 'services[0].taskDefinition' --output text)" \
      --query 'taskDefinition.containerDefinitions[0].image' --output text
    ```
  - Use commit IDs as tags, because `deploy.yml` rebuilds production's frontend from the commit named by staging's image tag.

## Expected costs (PRD §7.7, us-east-1 list prices; estimates, not a quote)

**Dev profile:**

| Item | While awake | While asleep |
|---|---|---|
| ALB (base plus minimal LCU) | ~$0.03/h | $0 (deleted) |
| Public IPv4: 2 on the ALB, 1 on the task | ~$0.015/h | $0 |
| Fargate Spot, 0.25 vCPU / 0.5 GB | ~$0.003–0.005/h | $0 |
| Route 53 zone, S3, ECR, CloudWatch Logs, SSM, CloudFront (free allowance), ACM, Budgets | n/a | ~$1–3/month |

| Usage | Monthly total |
|---|---|
| Awake ~20 h/week | ~$5–7 |
| Awake ~40 h/week | ~$10–12 |
| Left awake all month | ~$38–40; the $15 budget alert catches it early |

There's no NAT Gateway, which would cost about $33 per AZ per month. The tests assert this.

**Standard profile:**

- Running alone, with each environment's own VPC, cluster and ALB: about $55–60 a month for both.
- Sharing the tech team's VPC, cluster and ALB: probably about $15–25 a month extra.

## Standard-profile handoff notes (Rangers account)

1. **Fill in the configs.**
   - `config/rangers-staging.ts` and `config/rangers-production.ts` contain placeholders to confirm (PRD §11):
     - hostnames (`staging.scrivenly.com` and `scrivenly.com`);
     - `EMAIL_FROM` (`noreply@scrivenly.com`);
     - `BOOTSTRAP_ADMIN_EMAILS` (empty);
     - CPU and memory;
     - certificate ARNs.
   - `EMAIL_BCC` stays empty.
   - Set `SCRIBE_RANGERS_ACCOUNT` when deploying.
2. **Shared infrastructure** (`useExisting`):
   - Leave it unset to give each environment its own VPC (public subnets, no NAT), cluster and ALB.
   - To use the existing `rangers` VPC, cluster and ALB, uncomment `useExisting` and set:
     - `vpcId` and `clusterName`;
     - `albListenerArn`, `albSecurityGroupId` and `albDnsName`;
     - optionally `albRulePriority`, which must be unique on that listener. The default is 100, so give staging and
       production different values.
   - With `useExisting` set, synth needs credentials, because of `Vpc.fromLookup`. Tasks then run in the VPC's
     private-with-egress subnets without a public IP.
3. **Certificates.**
   - Without ARNs, the stack creates one ACM certificate for the hostname with DNS validation. CloudFormation waits until
     you add the CNAME shown in the ACM console wherever the hostname's DNS lives.
   - In us-east-1 that one certificate serves both CloudFront and the ALB.
   - Because CloudFront forwards the viewer `Host`, it validates the ALB's certificate against the public hostname, so the
     ALB certificate must cover it.
   - With a shared listener, the stack adds its certificate to that listener.
4. **Deploy order and the first image.**
   - **Deploy `scribe-rangers-staging` first.** It creates the shared `comms-scribe` repository and the SES identity;
     production imports the repository by name and relies on the identity.
   - No image exists for the first deploy, so:
     ```sh
     npx cdk deploy scribe-rangers-staging -c config=rangers-staging -c imageTag=bootstrap -c desiredCount=0
     # push the first image and register it on the (empty) service; run from CI or with CI=true
     CI=true AWS_ECR_IMAGE_NAME=<repo-uri> AWS_ECS_CLUSTER_STAGING=... AWS_ECS_SERVICE_STAGING=scribe-staging bin/deploy staging
     npx cdk deploy scribe-rangers-staging -c config=rangers-staging -c imageTag=<short commit ID>
     ```
   - Do the same for production with `-c config=rangers-production`. Its first real image comes from `bin/deploy production`,
     which copies staging's image.
5. **Secrets.** Set the Turnstile secret value after the first deploy:
   ```sh
   aws secretsmanager put-secret-value --secret-id scribe/rangers-staging/TURNSTILESECRET --secret-string '<key>'
   ```
   Do the same for production. SES needs production access in that account (PRD §9).
6. **DNS.** Point each hostname (CNAME or alias) at the `DistributionDomainName` output.
7. **GitHub Environment `rangers`.** Until `AWS_ECR_IMAGE_NAME` is set, `cicd.yml`'s deploy job skips its steps. Each value can
   be an environment secret or an environment variable:
   - **AWS access:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_DEFAULT_REGION`.
   - **ranger-deploy targets:**
     - `AWS_ECR_IMAGE_NAME`, the repository URI without a tag;
     - `AWS_ECS_CLUSTER_STAGING` and `AWS_ECS_SERVICE_STAGING` (`scribe-staging`);
     - `AWS_ECS_CLUSTER_PRODUCTION` and `AWS_ECS_SERVICE_PRODUCTION` (`scribe-production`).
   - **Frontend publishing:**
     - `AWS_S3_SPA_BUCKET_STAGING` and `AWS_CLOUDFRONT_DISTRIBUTION_STAGING`;
     - `AWS_S3_SPA_BUCKET_PRODUCTION` and `AWS_CLOUDFRONT_DISTRIBUTION_PRODUCTION`.
   - **Optional deploy notifications** (SES SMTP credentials work): `NOTIFY_SMTP_HOST`, `NOTIFY_SMTP_PORT`, `NOTIFY_SMTP_USER`,
     `NOTIFY_SMTP_PASSWORD`, `NOTIFY_EMAIL_SENDER` and `NOTIFY_EMAIL_RECIPIENT`.
   - **CI user permissions:**
     - ECR push to `comms-scribe`, plus `ecr:GetAuthorizationToken`;
     - `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition` and `ecs:UpdateService`;
     - `iam:PassRole` on both environments' task and execution roles;
     - `s3:ListBucket`, `s3:PutObject` and `s3:DeleteObject` on the SPA buckets;
     - `cloudfront:CreateInvalidation`.
8. **Production deployers.** `.github/workflows/deploy.yml` has a "Check user" allow-list (currently `["alexanderyoung"]`). The tech
   team edits it. It checks `github.triggering_actor`, so an unlisted user can't pass by re-running a listed user's run.
9. **ECR retention vs. production.** The lifecycle rule keeps the last 10 tagged images (per the PRD). If staging gets more
   than 10 deploys between promotions, the image production runs can expire, and a production task restart would then fail
   to pull. Promote regularly or raise `maxImageCount` in `lib/shared.ts`.

## Assumptions and decisions

These are choices made where the PRD is silent:

- **Config selection.** `-c config=<name>` is required, with no default.
  - The standard profile needs `-c imageTag`. CI and the tests use `imageTag=synth` or `abc1234`.
  - `-c desiredCount=0|1` is the escape hatch for first deploys. Values above 1 are rejected (Non-goals: one task).
- **Accounts** come from `SCRIBE_ALEX_DEV_ACCOUNT` and `SCRIBE_RANGERS_ACCOUNT`, not `CDK_DEFAULT_ACCOUNT`, so a synth or deploy
  never silently targets whatever account the current credentials belong to.
- **AZs** are `<region>a` and `<region>b`, set explicitly. A `ScribeStack` base class answers `availabilityZones` from config,
  because CDK would otherwise look the AZs up.
- **Dev cross-stack wiring** uses SSM parameters (`valueForStringParameter`, resolved at deploy time) and deterministic names.
  There are no `Fn::ImportValue`s, and a test enforces that.
- **Two dev certificates.** The CloudFront certificate is for `app.scrivenly.com`; the regional ALB certificate covers
  `origin.app.scrivenly.com` and `app.scrivenly.com`. Both are in us-east-1, as the PRD asks.
  - Outside us-east-1, `certificates.cloudFrontCertificateArn` is required.
- **Gallery caching.** Default TTL 0, maximum one year, `Authorization` and all query strings in the cache key, all methods
  allowed (uploads and comments go through `/api/gallery/*`).
  - Only responses with `Cache-Control` are cached, which today means the `/:filename` image route.
  - `Authorization` in the key keeps authenticated JSON routes from being shared between users.
- **`/api/*`** uses the managed `CachingDisabled` policy with `AllViewerExceptHostHeader` (dev) or `AllViewerAndCloudFrontHeaders-2022-06` (standard: it forwards `Host` and adds `CloudFront-Viewer-Address`, which the backend reads for the client IP before falling back to the spoofable first `X-Forwarded-For` entry). `AllViewerExceptHostHeader` already includes the CloudFront viewer-location headers.
  - The origin read timeout is 60 s (the default is 30 s) for slow requests such as batch email.
  - Viewer protocol is HTTPS-only, because redirecting a POST would turn it into a GET.
- **HSTS:** `max-age=63072000` (2 years; the old Worker sent a 10-year max-age). `includeSubDomains` and `preload` are
  opt-in per config (`hsts: { includeSubdomains, preload }`) and off in all three configs: on production's bare
  `scrivenly.com` they would cover every subdomain and ask for browser preload-list inclusion, which is hard to undo.
  The policy also adds `X-Content-Type-Options` and a `Referrer-Policy` default.
- **SPA publishing.** `static/` is uploaded with a one-year immutable `Cache-Control` and never deleted, so clients holding an
  older `index.html` still find their chunks. Everything else gets `no-cache` and stale files are deleted. Then `/*` is
  invalidated.
- **ECR.** Untagged images expire after 1 day. The tagged rule matches `*`, so `:dev` counts as one of the 10 kept.
  - `comms-scribe` is a per-account name: `rangers-staging` creates it and `rangers-production` imports it.
  - The SES identity follows the same pattern.
- **SES identity** is `scrivenly.com`, because `EMAIL_FROM` is `@scrivenly.com`, not the app.scrivenly.com zone. Its DNS is on
  Cloudflare, so DKIM is manual. The task role may send as any identity (`Resource: *`), because sandbox mode also checks
  recipients.
- **alex-dev email settings** keep today's behaviour:
  - BCC goes to `alexander.young@gmail.com` (`backend/src/utils/email.ts`);
  - the bootstrap admin is that same address (`userService.ts`);
  - budget alerts also go there.
  - Each can be overridden with an environment variable.
- **Removal policies.** Everything in dev is destroyed with its stack: buckets are emptied, the repository is emptied, and
  the zone is deleted. That makes PRD Phase 4's "destroy both stacks and redeploy" work.
  - A recreated zone has **new name servers**, and a recreated SES identity has **new DKIM tokens**. Update Cloudflare after a
    full teardown.
  - If zone deletion fails because ACM validation CNAMEs were left in it, delete them and retry.
  - In standard, buckets, the repository, logs and the secret are retained.
- **ALB ingress.** A stack-created ALB (dev, and standard without `useExisting.albListenerArn`) accepts only 443 from
  CloudFront's origin-facing managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`). Clients can't reach
  the ALB directly and bypass CloudFront's headers (HSTS). (The prefix list covers all of CloudFront, so another
  CloudFront distribution could still point at the ALB; a secret origin header checked by a listener rule would close
  that, if it ever matters.)
  - The prefix-list ID is region-specific. An `AwsCustomResource` (EC2 `DescribeManagedPrefixLists`) resolves it at
    deploy time, so synth stays offline. The custom resource adds a small Lambda function and role to the stack.
  - **Security group rule quota:** a rule that references this prefix list counts as about 55 rules toward the default
    quota of 60 inbound rules per security group. So there is exactly one such rule (443). There is no port-80 rule and
    no HTTP→HTTPS redirect listener: CloudFront connects to the origin `HTTPS_ONLY`, so port 80 is never used. Don't add
    more rules to this security group without raising the quota first.
  - With `useExisting.albListenerArn`, the shared ALB and its security group belong to the tech team and are left
    alone. Restricting that ALB to CloudFront (or not) is their call; the stack only adds a host rule and certificate.
- **`bin/dev-up` pushes the first `:dev` image itself.** It uses plain `docker push`, because ranger-deploy can't push until the
  service exists, and the service can't start until the image exists. Every later deploy goes through ranger-deploy.
- **Builds use `--platform linux/amd64`,** and the task definition pins X86_64, because Apple-silicon laptops otherwise build
  arm64 images.
- **`bin/deploy` builds only for `staging`.** `production` copies staging's image. CI sets `SKIP_BUILD=1` because it loads the
  image from the Docker build artifact.
- **Production frontend** is rebuilt from the commit in staging's image tag, so it matches the backend being promoted. The PRD
  says "the same commit's build"; artifacts from the staging run may have expired by then.
- **CI deploy gating** runs a first step inside the `rangers` environment. Secrets aren't available to job-level `if:`, and
  environment secrets only exist inside a job that declares the environment.
- **Frontend Cloudflare removal** also drops the `wrangler` devDependency and the committed `frontend/.wrangler/` state. They
  were only used for the Workers Sites deploy.

## Known gaps and follow-ups

- **CI is red until Phases 1 and 2 merge.** `backend/Dockerfile` doesn't exist yet (Phase 2), so the Docker job fails. The
  backend's 2 `pageService` tests ("should handle R2 errors gracefully") already fail on the baseline.
- **Pre-existing, Phase 2 scope:** `GET /api/gallery/:filename` serves any gallery object with no access check and
  `Cache-Control: public, max-age=31536000`. CloudFront caching doesn't widen that exposure, because the URL is already
  unauthenticated, but private media is reachable by anyone who knows its file name.
- **`CLAUDE.md` and the READMEs** still describe Cloudflare deploys. PRD R2.9 assigns that update to Phase 2.
