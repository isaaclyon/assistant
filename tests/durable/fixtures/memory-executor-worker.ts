import { readFileSync } from 'node:fs';
import { createMarkdownMemoryExecutor } from '../../../src/durable/memory-executor.js';
// argv: root, operation JSON file, crash point, git flag
const [root, file, point, git] = process.argv.slice(2) as [string, string, string, string];
const kill = () => { process.kill(process.pid, 'SIGKILL'); };
const executor = createMarkdownMemoryExecutor({ root, git: git === 'git', hooks: {
  afterReceipt: point === 'receipt' ? kill : undefined,
  afterMarkdown: point === 'markdown' ? kill : undefined,
  afterGit: point === 'git' ? kill : undefined,
} });
const operation = JSON.parse(readFileSync(file, 'utf8'));
await executor.execute(operation, { signal: new AbortController().signal, assertAuthority: async () => {} });
process.exit(0);
