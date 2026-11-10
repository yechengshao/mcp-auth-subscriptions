import { packageAuthorizer } from '../dist/infra/access/package-authorizer.js';

const result = packageAuthorizer(process.argv[2]);
process.stdout.write(`${JSON.stringify(result)}\n`);
