import { Stack, StackProps, Validations } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ScribeConfig } from './config';

/**
 * Base stack that answers `availabilityZones` from config. Without this, an env-specific stack
 * performs an AZ context lookup (even when the Vpc gets explicit AZs), and `cdk synth` would then
 * call AWS. Synth must work offline (contracts §6).
 */
export class ScribeStack extends Stack {
  private readonly configuredAzs: string[];

  constructor(scope: Construct, id: string, config: ScribeConfig, props: StackProps) {
    super(scope, id, props);
    this.configuredAzs = config.availabilityZones;
    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason: 'AZs are explicit on purpose so synth never performs an AZ lookup',
    });
  }

  get availabilityZones(): string[] {
    return this.configuredAzs;
  }
}
