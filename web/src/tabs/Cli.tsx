/**
 * CLI tab — PTY console,CWD = active repo root。WebSocket 雙向 + xterm.js。
 */
import Terminal from '../lib/Terminal';

interface Props {
  repo: string;
}

export default function Cli({ repo }: Props) {
  return (
    <div style={{ height: '100%', padding: 8, background: '#1e1e1e' }} data-loc="cli:root">
      <Terminal path={`/ws/cli/${repo}`} sessionKey={repo} />
    </div>
  );
}
