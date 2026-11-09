// Composer 列表接续（textarea 版）。
//
// 逻辑移植自 Cindy（makecindy/cindy, Apache-2.0）的
// `renderer/lib/composerListContinuation.ts` 与 `composerListTextarea.ts`：
// - Shift/Alt+Enter：命中列表前缀时自动接续序号/符号；空项则退出列表；
// - 空列表项按一次 Backspace：只删除前缀，保留换行。
// 未命中任何前缀时返回 null，交回调用方（Enter=发送）或浏览器默认行为。
(() => {
  // 顺序敏感：checkbox 必须先于 bullet（"- [ ] " 也满足 bullet 模式）。
  const CHECKBOX_RE = /^(\s*)([-+*])(\s+)\[[ xX]\](\s+|$)/u;
  const BULLET_RE = /^(\s*)([-+*•])(\s+)/u;
  const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)/u;
  const ORDERED_CJK_RE = /^(\s*)(\d{1,9})(、)(\s*)/u;
  const QUOTE_RE = /^(\s*)(>)(\s+)/u;

  function matchListPrefix(line) {
    let match = line.match(CHECKBOX_RE);
    if (match) {
      return {
        prefixLength: match[0].length,
        nextPrefix: `${match[1]}${match[2]}${match[3]}[ ]${match[4] || ' '}`
      };
    }
    match = line.match(BULLET_RE);
    if (match) return { prefixLength: match[0].length, nextPrefix: match[0] };
    match = line.match(ORDERED_RE);
    if (match) {
      return {
        prefixLength: match[0].length,
        nextPrefix: `${match[1]}${Number(match[2]) + 1}${match[3]}${match[4]}`
      };
    }
    match = line.match(ORDERED_CJK_RE);
    if (match) {
      return {
        prefixLength: match[0].length,
        nextPrefix: `${match[1]}${Number(match[2]) + 1}${match[3]}${match[4]}`
      };
    }
    match = line.match(QUOTE_RE);
    if (match) return { prefixLength: match[0].length, nextPrefix: match[0] };
    return null;
  }

  function computeListContinuation(lineBeforeCaret, lineAfterCaret = '') {
    const match = matchListPrefix(lineBeforeCaret);
    if (!match) return null;
    const rest = lineBeforeCaret.slice(match.prefixLength);
    // 空项判定看整行（光标前剩余 + 光标后正文），`1. |todo` 不算空项。
    if (rest.trim().length === 0 && lineAfterCaret.trim().length === 0) {
      return { action: 'exit' };
    }
    return { action: 'continue', insert: match.nextPrefix };
  }

  const lineStartOffset = (value, caret) => value.lastIndexOf('\n', caret - 1) + 1;

  function computeTextareaContinuation(value, selectionStart, selectionEnd) {
    if (selectionStart !== selectionEnd) return null;
    const caret = selectionStart;
    const lineStart = lineStartOffset(value, caret);
    const lineBeforeCaret = value.slice(lineStart, caret);
    const lineEnd = value.indexOf('\n', caret);
    const lineAfterCaret = value.slice(caret, lineEnd === -1 ? value.length : lineEnd);
    const continuation = computeListContinuation(lineBeforeCaret, lineAfterCaret);
    if (!continuation) return null;
    if (continuation.action === 'exit') {
      return { value: value.slice(0, lineStart) + value.slice(caret), caret: lineStart };
    }
    const insert = `\n${continuation.insert}`;
    return {
      value: value.slice(0, caret) + insert + value.slice(caret),
      caret: caret + insert.length
    };
  }

  function computeTextareaBackspace(value, selectionStart, selectionEnd) {
    if (selectionStart !== selectionEnd) return null;
    const caret = selectionStart;
    const nextChar = value[caret];
    if (nextChar !== undefined && nextChar !== '\n') return null;
    const lineStart = lineStartOffset(value, caret);
    const line = value.slice(lineStart, caret);
    const match = matchListPrefix(line);
    if (!match) return null;
    if (line.slice(match.prefixLength).trim().length > 0) return null;
    return { value: value.slice(0, lineStart) + value.slice(caret), caret: lineStart };
  }

  window.OwnerComposerList = {
    matchListPrefix,
    computeListContinuation,
    computeTextareaContinuation,
    computeTextareaBackspace
  };
})();
