// Source for public/vendor/codemirror/cm.min.js. Rebuild with art/build-codemirror.sh.
// One file with the editor and the languages the phone app knows. Loaded only when you tap Edit.
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view';
export { EditorState, Compartment } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap, undo, redo, indentWithTab, indentMore, indentLess } from '@codemirror/commands';
export { searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search';
export { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, StreamLanguage, indentUnit } from '@codemirror/language';
export { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
// File extension -> language
const L = {
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(), jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }),
  py: () => python(), html: () => html(), htm: () => html(), vue: () => html(), svelte: () => html(),
  css: () => css(), scss: () => css(), json: () => json(), md: () => markdown(), mdx: () => markdown(), markdown: () => markdown(),
  yml: () => yaml(), yaml: () => yaml(), sql: () => sql(), c: () => cpp(), h: () => cpp(), cpp: () => cpp(), cc: () => cpp(), hpp: () => cpp(),
  java: () => java(), kt: () => java(), rs: () => rust(), go: () => go(), php: () => php(), xml: () => xml(), svg: () => xml(),
  sh: () => StreamLanguage.define(shell), bash: () => StreamLanguage.define(shell), zsh: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml), dockerfile: () => StreamLanguage.define(dockerFile),
};
export function languageFor(name) {
  const base = String(name).split('/').pop().toLowerCase();
  if (base === 'dockerfile') return L.dockerfile();
  if (/^\.(bashrc|zshrc|profile)$/.test(base)) return L.sh();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return L[ext] ? L[ext]() : [];
}
