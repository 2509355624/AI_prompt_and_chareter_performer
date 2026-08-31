const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const CACHE_DIR = path.join(__dirname, 'data', 'matte_cache');
const PUBLIC_DIR = path.join(__dirname, 'public');
const inFlight = new Map();

/** small ≈ 更快但边缘糊；medium ≈ 更干净（薄纱/发丝更好） */
const MATTE_MODEL = process.env.MATTE_MODEL === 'small' ? 'small' : 'medium';

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
        .update(`${filePath}|${stat.mtimeMs}|${stat.size}|${maxSide}|${MATTE_MODEL}`)
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
            cached: true,
            model: MATTE_MODEL
        };
    }

    if (inFlight.has(key)) return inFlight.get(key);

    const task = (async () => {
        const removeBackground = await getRemover();
        const blob = await removeBackground(imageInputFromPath(filePath), {
            model: MATTE_MODEL,
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
            cached: false,
            model: MATTE_MODEL
        };
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, task);
    return task;
}

/**
 * Accept browser-uploaded image (data URL / raw base64) for frame.html experiments.
 * Saves under public/uploads/frame_matte/ then reuses the file-based matte pipeline.
 */
async function getMatteFromDataUrl(dataUrl, maxSide = 1280) {
    const raw = String(dataUrl || '').trim();
    if (!raw) throw new Error('缺少图片数据');

    let mime = 'image/png';
    let b64 = raw;
    const m = /^data:([^;]+);base64,(.+)$/i.exec(raw);
    if (m) {
        mime = m[1] || mime;
        b64 = m[2];
    }

    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('图片数据无效');

    const ext = /jpeg|jpg/i.test(mime) ? 'jpg' : (/webp/i.test(mime) ? 'webp' : 'png');
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
    const dir = path.join(PUBLIC_DIR, 'uploads', 'frame_matte');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${hash}.${ext}`;
    const abs = path.join(dir, fileName);
    if (!fs.existsSync(abs)) {
        fs.writeFileSync(abs, buf);
    }

    const result = await getMatteForeground(`/uploads/frame_matte/${fileName}`, maxSide);
    return {
        ...result,
        sourceUrl: `/uploads/frame_matte/${fileName}`
    };
}

module.exports = {
    getMatteForeground,
    getMatteFromDataUrl,
    resolveUploadPath
};
