import globals from 'globals';
export default [{
  files: ['**/*.js','**/*.mjs'],
  ignores: ['dist/**','tmp/**','data/**','node_modules/**','runtime/**'],
  languageOptions: {ecmaVersion:2024,sourceType:'module',globals:{...globals.node,...globals.browser}},
  rules: {'no-undef':'error','no-unreachable':'error','no-dupe-keys':'error','no-constant-condition':['error',{checkLoops:false}], 'no-unused-vars':['warn',{argsIgnorePattern:'^_',caughtErrors:'none'}]}
}];
