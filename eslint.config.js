import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({ ignores: ['dist/', 'node_modules/'] }, js.configs.recommended, tseslint.configs.recommended, {
  // ship and the workflow scripts are CLI output for people, so they print to the terminal
  // (see CLAUDE.md); a server would log through @ideasquared/log instead.
  rules: {
    'no-console': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
  },
});
