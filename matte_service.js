const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const CACHE_DIR = path.join(__dirname, 'data', 'matte_cache');
const PUBLIC_DIR = path.join(__dirname, 'public');
const inFlight = new Map();

let removeBackgroundFn = null;

async function getRemover() {
    if (!removeBackgroundFn) {
        const mod = require('@imgly/background-removal-node');
        removeBackgroundFn = mod.removeBackground;
    }
    return removeBackgroundFn;
}

function resolveUploadPath(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;

    let pathname = raw;
    if (/^https?:\/\//i.test(pathname)) {
        try {
            pathname = new URL(pathname).pathname;
        } catch (_) {
            return null;
        }
    }

    if (!pathname.startsWith('/uploads/')) return null;

    const rel = pathname.replace(/^\//, '').split('/').join(path.sep);
    const abs = path.normalize(path.join(PUBLIC_DIR, rel));
    const publicRoot = path.normalize(PUBLIC_DIR + path.sep);
    if (!abs.startsWith(publicRoot)) return null;
    return abs;
}

function cacheKeyFor(filePath, maxSide) {
    const stat = fs.statSync(filePath);
    return crypto
        .createHash('sha256')
        .update(`${filePath}|${stat.mtimeMs}|${stat.size}|${maxSide}`)
        .digest('hex');
}

function imageInputFromPath(filePath) {
    // file:// URL — avoids Windows "D:" being parsed as URL protocol
    return pathToFileURL(filePath);
}

async function blobToBuffer(blob) {
    if (Buffer.isBuffer(blob)) return blob;
    if (typeof blob.arrayBuffer === 'function') {
        return Buffer.from(await blob.arrayBuffer());
    }
    const chunks = [];
    for await (const chunk of blob) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function getMatteForeground(url, maxSide = 1280) {
    const filePath = resolveUploadPath(url);
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('图片不存在或路径无效');
    }

    const side = Math.min(2048, Math.max(256, Number(maxSide) || 1280));
    const key = cacheKeyFor(filePath, side);
    const cacheFile = path.join(CACHE_DIR, `${key}.png`);

    if (fs.existsSync(cacheFile)) {
        const buf = fs.readFileSync(cacheFile);
        return {
            foregroundDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
            cached: true
        };
    }

    if (inFlight.has(key)) return inFlight.get(key);

    const task = (async () => {
        const removeBackground = await getRemover();
        const blob = await removeBackground(imageInputFromPath(filePath), {
            model: 'small',
            output: {
                format: 'image/png',
                type: 'foreground'
            }
        });
        const buf = await blobToBuffer(blob);
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, buf);
        return {
            foregroundDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
            cached: false
        };
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, task);
    return task;
}

module.exports = {
    getMatteForeground,
    resolveUploadPath
};
