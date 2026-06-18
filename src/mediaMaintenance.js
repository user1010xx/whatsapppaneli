const fs = require('node:fs');
const path = require('node:path');

function collectReferencedMediaFiles(store) {
  const referenced = new Set();
  if (!store) return referenced;
  for (const message of store.all('messages')) {
    if (message.mediaFile) referenced.add(String(message.mediaFile).replace(/\\/g, '/'));
  }
  return referenced;
}

function pruneOldMedia(mediaDir, maxAgeDays = 90, store = null) {
  if (!maxAgeDays || maxAgeDays <= 0) return { removed: 0, skippedReferenced: 0 };
  if (!mediaDir || !fs.existsSync(mediaDir)) return { removed: 0, skippedReferenced: 0 };
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const referenced = collectReferencedMediaFiles(store);
  const baseDir = path.resolve(mediaDir);
  let removed = 0;
  let skippedReferenced = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.posix.normalize(path.relative(baseDir, full).split(path.sep).join('/'));
      if (referenced.has(rel)) {
        skippedReferenced += 1;
        continue;
      }
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch {}
      }
    }
  };

  walk(mediaDir);
  return { removed, skippedReferenced };
}

function pruneOrphanMedia(mediaDir, store = null) {
  if (!mediaDir || !fs.existsSync(mediaDir)) return { removed: 0 };
  const referenced = collectReferencedMediaFiles(store);
  const baseDir = path.resolve(mediaDir);
  let removed = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          if (!fs.readdirSync(full).length) fs.rmdirSync(full);
        } catch {}
        continue;
      }
      const rel = path.posix.normalize(path.relative(baseDir, full).split(path.sep).join('/'));
      if (!referenced.has(rel)) {
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch {}
      }
    }
  };

  walk(mediaDir);
  return { removed };
}

module.exports = { collectReferencedMediaFiles, pruneOldMedia, pruneOrphanMedia };