import { createHash } from 'node:crypto';

export const identityKey = (issuer: string, subject: string): string =>
  createHash('sha256').update(JSON.stringify([issuer, subject]), 'utf8').digest('hex');

export const identityPartition = (environment: string, issuer: string, subject: string): string =>
  `ENV#${environment}#IDENTITY#${identityKey(issuer, subject)}`;
