import { describe, expect, it } from 'vitest';
import { isMigrationFile } from '../src/migrations.ts';

describe('isMigrationFile', () => {
  it('treats ., ./ and / as the repo root', () => {
    ['.', './', '/'].forEach((root) => {
      expect(isMigrationFile('0001_init.sql', [root])).toBe(true);
      expect(isMigrationFile('db/0001_init.sql', [root])).toBe(false);
    });
  });
  it('matches one segment per * and ignores subfolders', () => {
    expect(isMigrationFile('services/pets/src/migrations/001_x.ts', ['services/*/src/migrations'])).toBe(true);
    expect(isMigrationFile('packages/db/migrations/meta/_journal.json', ['packages/db/migrations'])).toBe(false);
  });
});
