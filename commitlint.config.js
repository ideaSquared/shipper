export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot titles are "chore(deps): Bump <pkg> ..." with a capital B, which subject-case rejects.
  ignores: [(message) => /^chore\((deps|ci)\): [Bb]ump /.test(message)],
};
