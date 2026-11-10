import { readFileSync } from 'node:fs';
import { checkCognitoCompatibility } from '../infra/access/cognito-compatibility.js';

try {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) throw new Error('usage: check_cognito_compatibility <describe-snapshot.json>');
  const result = checkCognitoCompatibility(JSON.parse(readFileSync(inputPath, 'utf8')) as unknown);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.compatible) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'invalid_cognito_compatibility_snapshot'}\n`);
  process.exitCode = 2;
}
