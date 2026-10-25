/**
 * cmTheme — CodeMirror 6 的深色語法高亮(SPEC §3.1 / §4.1)。
 *
 * CM6 內建的 `defaultHighlightStyle` 是亮底配色(keyword `#708` 紫等),放在
 * porthole 的深色底上幾乎讀不到。這裡用 `theme.ts` 的 `CODE_TOKENS` 自建一份
 * `HighlightStyle` —— **與預覽的 `.tok-*` 共用同一組色值**,編輯器與預覽才會一致。
 */
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { CODE_TOKENS } from '../theme';

export const darkHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: CODE_TOKENS.keyword },
  { tag: [t.operator], color: CODE_TOKENS.keyword },
  { tag: [t.atom, t.bool, t.null, t.labelName], color: CODE_TOKENS.atom },
  { tag: [t.url], color: CODE_TOKENS.atom, textDecoration: 'underline' },
  { tag: [t.literal, t.number, t.integer, t.float, t.inserted], color: CODE_TOKENS.number },
  { tag: [t.string, t.character, t.attributeValue], color: CODE_TOKENS.string },
  { tag: [t.deleted], color: CODE_TOKENS.invalid },
  { tag: [t.regexp, t.escape], color: CODE_TOKENS.regexp },
  { tag: [t.variableName], color: CODE_TOKENS.variable },
  { tag: [t.typeName, t.namespace], color: CODE_TOKENS.type },
  { tag: [t.className, t.tagName], color: CODE_TOKENS.class },
  { tag: [t.macroName, t.propertyName, t.attributeName], color: CODE_TOKENS.property },
  { tag: [t.comment, t.lineComment, t.blockComment], color: CODE_TOKENS.comment, fontStyle: 'italic' },
  { tag: [t.meta], color: CODE_TOKENS.meta },
  { tag: [t.invalid], color: CODE_TOKENS.invalid },
], { themeType: 'dark' });
