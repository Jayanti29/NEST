import { cp, mkdir } from 'node:fs/promises';

await mkdir('public', { recursive: true });
await cp('client/dist', 'public', { recursive: true, force: true });
