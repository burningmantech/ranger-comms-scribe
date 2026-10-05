# Shared setup for bin/dev-up, bin/dev-down and bin/dev-deploy. Sourced, not executed.
#
# Environment:
#   SCRIBE_CONFIG            dev config name (default alex-dev)
#   SCRIBE_ALEX_DEV_ACCOUNT  the 12-digit account the dev stacks live in (default 821327748249)
#   AWS_PROFILE              optional: the AWS CLI profile for that account
#   SCRIBE_ALEX_DEV_REGION   optional: default us-east-1 (the same variable the CDK config
#                            reads, so the scripts and the stacks agree on the region)

# shellcheck shell=bash

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
config="${SCRIBE_CONFIG:-alex-dev}"
region="${SCRIBE_ALEX_DEV_REGION:-us-east-1}"
export AWS_REGION="${region}" AWS_DEFAULT_REGION="${region}"
ssm_prefix="/scribe/${config}"
# shellcheck disable=SC2034  # used by the scripts that source this file
compute_stack="scribe-dev-compute"

export SCRIBE_ALEX_DEV_ACCOUNT="${SCRIBE_ALEX_DEV_ACCOUNT:-821327748249}"
if [ -z "${SCRIBE_ALEX_DEV_ACCOUNT:-}" ]; then
    echo "Set SCRIBE_ALEX_DEV_ACCOUNT to the dev account ID (and AWS_PROFILE if needed)." >&2
    exit 64
fi

caller_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "${caller_account}" != "${SCRIBE_ALEX_DEV_ACCOUNT}" ]; then
    echo "AWS credentials are for account ${caller_account}, not SCRIBE_ALEX_DEV_ACCOUNT=${SCRIBE_ALEX_DEV_ACCOUNT}." >&2
    echo "Pick the right AWS_PROFILE and try again." >&2
    exit 77
fi

echo "==> Config ${config}, account ${caller_account}, region ${region}${AWS_PROFILE:+, profile ${AWS_PROFILE}}"

# Read a value the persistent stack published under /scribe/<config>/.
get_param() {
    aws ssm get-parameter --name "${ssm_prefix}/$1" --query Parameter.Value --output text
}

# Run the CDK CLI from infra/, installing its dependencies on first use.
run_cdk() {
    (
        cd "${repo_root}/infra" || exit 1
        if [ ! -d node_modules ]; then
            echo "==> Installing infra dependencies (npm ci)"
            npm ci
        fi
        npx cdk "$@" -c "config=${config}"
    )
}
