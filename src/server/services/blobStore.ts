import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The small slice of an S3-style API the app needs. Raw emails are stored by content hash. */
export interface BlobStore {
  putObject(input: { Key: string; Body: Buffer | string; ContentType: string }): Promise<{ ETag: string }>;
  getObject(input: { Key: string }): Promise<{ Body: Buffer; ContentType: string }>;
  clear(): Promise<void>;
}

export function contentKey(body: Buffer | string): string {
  const hash = createHash('sha256').update(body).digest('hex');
  return `raw-emails/${hash.slice(0, 2)}/${hash}`;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!/^[a-z0-9/-]+$/.test(key) || key.includes('..')) throw new Error(`invalid blob key ${key}`);
    return join(this.root, key);
  }

  async putObject({ Key, Body, ContentType }: { Key: string; Body: Buffer | string; ContentType: string }) {
    const file = this.path(Key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Body);
    await writeFile(`${file}.meta`, JSON.stringify({ ContentType }));
    return { ETag: Key.split('/').at(-1)! };
  }

  async getObject({ Key }: { Key: string }) {
    const file = this.path(Key);
    const Body = await readFile(file);
    const meta = JSON.parse(await readFile(`${file}.meta`, 'utf8')) as { ContentType: string };
    return { Body, ContentType: meta.ContentType };
  }

  async clear() {
    await rm(join(this.root, 'raw-emails'), { recursive: true, force: true });
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly items = new Map<string, { Body: Buffer; ContentType: string }>();

  async putObject({ Key, Body, ContentType }: { Key: string; Body: Buffer | string; ContentType: string }) {
    this.items.set(Key, { Body: Buffer.from(Body), ContentType });
    return { ETag: Key.split('/').at(-1)! };
  }

  async getObject({ Key }: { Key: string }) {
    const item = this.items.get(Key);
    if (!item) throw new Error(`NoSuchKey: ${Key}`);
    return item;
  }

  async clear() {
    this.items.clear();
  }
}
