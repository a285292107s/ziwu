import antfu from '@antfu/eslint-config'

export default antfu(
  {},
  {
    files: ['src/background/main.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        chrome: 'readonly',
      },
    },
  },
)
