import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PlannedFileWrite {
  filePath: string;
  content: string;
}

interface PreparedWrite extends PlannedFileWrite {
  tempPath: string;
  backupPath: string;
  existed: boolean;
  committed: boolean;
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup. The original failure is more useful to callers.
  }
}

export function writeFilesAtomically(writes: PlannedFileWrite[]): void {
  if (writes.length === 0) return;

  const unique = new Set<string>();
  for (const write of writes) {
    const normalized = path.resolve(write.filePath);
    if (unique.has(normalized)) {
      throw new Error(`Duplicate planned write for ${normalized}`);
    }
    unique.add(normalized);
  }

  const token = randomUUID();
  const prepared: PreparedWrite[] = writes.map((write, index) => {
    const filePath = path.resolve(write.filePath);
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    fs.mkdirSync(dir, { recursive: true });
    return {
      filePath,
      content: write.content,
      tempPath: path.join(dir, `.${base}.i18n-scan-${token}-${index}.tmp`),
      backupPath: path.join(dir, `.${base}.i18n-scan-${token}-${index}.bak`),
      existed: fs.existsSync(filePath),
      committed: false
    };
  });

  try {
    for (const item of prepared) {
      fs.writeFileSync(item.tempPath, item.content, { encoding: 'utf8', flag: 'wx' });
      if (item.existed) {
        const mode = fs.statSync(item.filePath).mode;
        fs.chmodSync(item.tempPath, mode);
      }
    }

    for (const item of prepared) {
      if (item.existed) fs.renameSync(item.filePath, item.backupPath);
      try {
        fs.renameSync(item.tempPath, item.filePath);
        item.committed = true;
      } catch (error) {
        if (item.existed && fs.existsSync(item.backupPath)) {
          fs.renameSync(item.backupPath, item.filePath);
        }
        throw error;
      }
    }

    for (const item of prepared) safeUnlink(item.backupPath);
  } catch (error) {
    for (const item of [...prepared].reverse()) {
      if (item.committed) safeUnlink(item.filePath);
      if (fs.existsSync(item.backupPath)) {
        try {
          fs.renameSync(item.backupPath, item.filePath);
        } catch {
          // Preserve the original failure. Backup is intentionally left behind.
        }
      }
      safeUnlink(item.tempPath);
    }
    throw error;
  }
}
