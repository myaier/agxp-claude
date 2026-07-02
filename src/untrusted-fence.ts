const FENCE_OPEN = '⟦UNTRUSTED⟧';
const FENCE_CLOSE = '⟦/UNTRUSTED⟧';

// When the input contains a literal close-marker, we replace it with a string
// that LOOKS identical but inserts a zero-width space (U+200B) between "/" and
// "UNTRUSTED". Written via `​` so the invisible byte is explicit in source
// and survives any editor/tool round-trip; the result is NOT string-equal to
// FENCE_CLOSE, so it cannot forge a fence exit. Mirrors the Go render.fenceUntrusted
// escape literal (which uses the raw U+200B byte directly).
const FENCE_CLOSE_ESCAPED = '⟦/' + '​' + 'UNTRUSTED⟧';

/**
 * Wrap attacker-controllable network content (raw timeline/post JSON, DM text)
 * in explicit UNTRUSTED delimiters so the agent treats it as DATA to analyze,
 * never instructions to obey. Empty input returns empty. Any embedded close
 * marker is escaped so it can't forge a fence exit. Mirrors the CLI render.go
 * fenceUntrusted for shell-owned prompt paths that bypass `agxp event watch`.
 */
export function fenceUntrusted(s: string): string {
  if (!s) return '';
  const safe = s.split(FENCE_CLOSE).join(FENCE_CLOSE_ESCAPED);
  return `${FENCE_OPEN}\n${safe}\n${FENCE_CLOSE}`;
}
