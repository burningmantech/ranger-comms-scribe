#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app';

// Select the environment with `-c config=<name>`; see infra/README.md.
buildApp({}, new App());
