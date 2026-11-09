import { writeFileSync } from 'node:fs';
import { observabilityTemplate } from './template.js';
writeFileSync(new URL('../../../infra/observability/template.json', import.meta.url), JSON.stringify(observabilityTemplate(), null, 2) + '\n');
