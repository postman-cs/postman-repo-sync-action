export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0, 'always', 100],
  },
  // Dependabot writes release-note bodies that exceed body-max-line-length;
  // its messages are machine-generated, so linting them only blocks merges.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};
