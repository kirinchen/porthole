/**
 * fenced code 語法高亮的語言清單 —— 編輯器(CM6 markdown codeLanguages)與
 * 預覽(CodeBlock + highlightTree)共用同一份,確保兩邊高亮一致。
 *
 * 精選常用語言,各自 lazy dynamic import(code-split,不撐主 bundle)。
 * 語言 tag(```後那段)比對 name / alias;不在清單的語言(如 cobol)維持純文字。
 */
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

export const CODE_LANGUAGES = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'ts', 'tsx', 'typescript', 'node'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: 'python',
    alias: ['py'],
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({ name: 'java', load: () => import('@codemirror/lang-java').then((m) => m.java()) }),
  LanguageDescription.of({ name: 'json', load: () => import('@codemirror/lang-json').then((m) => m.json()) }),
  LanguageDescription.of({
    name: 'rust',
    alias: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({ name: 'go', load: () => import('@codemirror/lang-go').then((m) => m.go()) }),
  LanguageDescription.of({ name: 'sql', load: () => import('@codemirror/lang-sql').then((m) => m.sql()) }),
  LanguageDescription.of({
    name: 'yaml',
    alias: ['yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  }),
  LanguageDescription.of({ name: 'html', load: () => import('@codemirror/lang-html').then((m) => m.html()) }),
  LanguageDescription.of({ name: 'css', load: () => import('@codemirror/lang-css').then((m) => m.css()) }),
  LanguageDescription.of({ name: 'xml', load: () => import('@codemirror/lang-xml').then((m) => m.xml()) }),
  LanguageDescription.of({
    name: 'cpp',
    alias: ['c', 'c++', 'h', 'hpp'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'shell',
    alias: ['bash', 'sh', 'zsh', 'shell-session', 'console'],
    load: () =>
      import('@codemirror/legacy-modes/mode/shell').then(
        (m) => new LanguageSupport(StreamLanguage.define(m.shell)),
      ),
  }),
];

/** 依語言 tag(name / alias,模糊比對)找對應語言描述;找不到回 null(→ 維持純文字)。 */
export function findCodeLanguage(tag: string): LanguageDescription | null {
  if (!tag) return null;
  return LanguageDescription.matchLanguageName(CODE_LANGUAGES, tag, true);
}
