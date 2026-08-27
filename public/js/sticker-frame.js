/**
 * Canvas renderer for Xiaohongshu / sticker-style image frames.
 * Shared visual language with character.html export strips.
 */
(function (global) {
    function roundRect(ctx, x, y, w, h, r) {
        const radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
    }

    function hexToRgba(hex, alpha) {
        const raw = String(hex || '#f6edda').replace('#', '');
        const full = raw.length === 3
            ? raw.split('').map((c) => c + c).join('')
            : raw.padEnd(6, '0').slice(0, 6);
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function drawCoverImage(ctx, image, x, y, w, h) {
        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;
        if (!imgW || !imgH) return;
        const scale = Math.max(w / imgW, h / imgH);
        const sw = imgW * scale;
        const sh = imgH * scale;
        const sx = x + (w - sw) / 2;
        const sy = y + (h - sh) / 2;
        ctx.drawImage(image, sx, sy, sw, sh);
    }

    function drawFrostedGlassBackground(ctx, image, x, y, w, h, opts) {
        const blur = Number(opts.glassBlur) || 28;
        const overlayAlpha = Number(opts.glassOverlay) ?? 0.48;
        const frostAlpha = Number(opts.glassFrost) ?? 0.22;
        const tint = opts.bgColor || '#f6edda';

        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.ceil(w));
        off.height = Math.max(1, Math.ceil(h));
        const octx = off.getContext('2d');
        octx.filter = `blur(${blur}px) saturate(1.15)`;
        drawCoverImage(octx, image, 0, 0, w, h);
        octx.filter = 'none';

        ctx.save();
        roundRect(ctx, x, y, w, h, 14);
        ctx.clip();
        ctx.drawImage(off, x, y, w, h);
        ctx.fillStyle = hexToRgba(tint, overlayAlpha);
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = `rgba(255, 255, 255, ${frostAlpha})`;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    }

    function fillSolidBackground(ctx, x, y, w, h, color) {
        ctx.fillStyle = color;
        roundRect(ctx, x, y, w, h, 14);
        ctx.fill();
    }

    function drawTape(ctx, x, y, w, h, variant) {
        ctx.save();
        ctx.globalAlpha = variant === 'warm' ? 0.32 : 0.28;
        ctx.fillStyle = variant === 'warm' ? '#e8503a' : 'rgba(255, 248, 220, 0.95)';
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(-0.12);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
    }

    function wrapLines(ctx, text, maxWidth) {
        const raw = String(text || '').trim();
        if (!raw) return [];
        const lines = [];
        let line = '';
        for (const ch of raw) {
            const test = line + ch;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = ch;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    const PRESETS = {
        xhs: {
            label: '小红书经典',
            padding: 32,
            bgColor: '#f6edda',
            glassBg: true,
            glassBlur: 32,
            glassOverlay: 0.42,
            glassFrost: 0.28,
            borderWidth: 2.5,
            borderColor: '#26221c',
            borderRadius: 12,
            shadowOffset: 3,
            shadowAlpha: 0.45,
            tiltDeg: -0.6,
            tape: true,
            captionFontSize: 14,
            outputWidth: 390
        },
        chat: {
            label: '对话条同款',
            padding: 20,
            bgColor: '#f6edda',
            glassBg: true,
            glassBlur: 24,
            glassOverlay: 0.5,
            glassFrost: 0.3,
            borderWidth: 2,
            borderColor: '#26221c',
            borderRadius: 12,
            shadowOffset: 3,
            shadowAlpha: 0.45,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 390
        },
        polaroid: {
            label: '拍立得',
            padding: 28,
            bgColor: '#fffdf6',
            glassBg: true,
            glassBlur: 20,
            glassOverlay: 0.55,
            glassFrost: 0.35,
            borderWidth: 2,
            borderColor: '#26221c',
            borderRadius: 4,
            shadowOffset: 4,
            shadowAlpha: 0.35,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 15,
            outputWidth: 390,
            extraBottomPadding: 48
        },
        minimal: {
            label: '简约白边',
            padding: 24,
            bgColor: '#ffffff',
            glassBg: false,
            borderWidth: 0,
            borderColor: '#26221c',
            borderRadius: 0,
            shadowOffset: 0,
            shadowAlpha: 0,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 13,
            outputWidth: 390
        }
    };

    function mergeOptions(options) {
        const presetKey = options?.preset && PRESETS[options.preset] ? options.preset : 'xhs';
        return { ...PRESETS[presetKey], ...options, preset: presetKey };
    }

    function measureFrame(image, options) {
        const opts = mergeOptions(options);
        const padding = Number(opts.padding) || 24;
        const borderWidth = Number(opts.borderWidth) || 0;
        const shadowOffset = Number(opts.shadowOffset) || 0;
        const captionFontSize = Number(opts.captionFontSize) || 14;
        const outputWidth = Number(opts.outputWidth) || 0;
        const extraBottom = Number(opts.extraBottomPadding) || 0;
        const caption = String(opts.caption || '').trim();

        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;
        if (!imgW || !imgH) {
            return { width: 100, height: 100, drawW: 80, drawH: 80, padding, captionLines: [] };
        }

        const contentMaxW = outputWidth > 0 ? outputWidth - padding * 2 : imgW;
        const scale = outputWidth > 0 ? contentMaxW / imgW : 1;
        const drawW = Math.max(1, Math.round(imgW * scale));
        const drawH = Math.max(1, Math.round(imgH * scale));

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${captionFontSize}px "Noto Sans SC", sans-serif`;
        const captionLines = caption
            ? wrapLines(ctx, caption, Math.max(40, drawW - 8))
            : [];
        const captionBlockH = captionLines.length
            ? captionLines.length * captionFontSize * 1.45 + 12
            : 0;

        const innerW = drawW + borderWidth * 2;
        const innerH = drawH + borderWidth * 2;
        const cardW = innerW + padding * 2;
        const cardH = innerH + padding * 2 + extraBottom + captionBlockH;
        const width = cardW + shadowOffset;
        const height = cardH + shadowOffset;

        return {
            width: Math.ceil(width),
            height: Math.ceil(height),
            drawW,
            drawH,
            padding,
            captionLines,
            captionFontSize,
            opts
        };
    }

    function renderStickerFrame(image, options) {
        const measured = measureFrame(image, options);
        const opts = measured.opts;
        const {
            bgColor,
            borderWidth,
            borderColor,
            borderRadius,
            shadowOffset,
            shadowAlpha,
            tiltDeg,
            tape,
            glassBg
        } = opts;
        const padding = measured.padding;
        const drawW = measured.drawW;
        const drawH = measured.drawH;
        const extraBottom = Number(opts.extraBottomPadding) || 0;
        const captionBlockH = measured.captionLines.length
            ? measured.captionLines.length * measured.captionFontSize * 1.45 + 12
            : 0;

        const canvasW = measured.width;
        const canvasH = measured.height;
        const cardW = drawW + borderWidth * 2 + padding * 2;
        const cardH = drawH + borderWidth * 2 + padding * 2 + extraBottom + captionBlockH;

        const canvas = document.createElement('canvas');
        const dpr = Math.min(2, global.devicePixelRatio || 1);
        canvas.width = Math.ceil(canvasW * dpr);
        canvas.height = Math.ceil(canvasH * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const useGlass = glassBg !== false;

        if (useGlass) {
            drawFrostedGlassBackground(ctx, image, 0, 0, canvasW, canvasH, opts);
        } else {
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, canvasW, canvasH);
        }

        if (tiltDeg) {
            ctx.save();
            ctx.translate(canvasW / 2, canvasH / 2);
            ctx.rotate((Number(tiltDeg) * Math.PI) / 180);
            ctx.translate(-canvasW / 2, -canvasH / 2);
        }

        if (useGlass) {
            drawFrostedGlassBackground(ctx, image, 0, 0, cardW, cardH, opts);
        } else {
            fillSolidBackground(ctx, 0, 0, cardW, cardH, bgColor);
        }

        if (tape) {
            drawTape(ctx, padding + 8, padding - 6, 52, 16, 'warm');
            drawTape(ctx, cardW - padding - 60, padding - 6, 52, 16, 'default');
        }

        const imgX = padding;
        const imgY = padding;

        if (shadowOffset > 0 && shadowAlpha > 0) {
            ctx.fillStyle = `rgba(38, 34, 28, ${shadowAlpha})`;
            roundRect(ctx, imgX + shadowOffset, imgY + shadowOffset, drawW, drawH, borderRadius);
            ctx.fill();
        }

        ctx.save();
        roundRect(ctx, imgX, imgY, drawW, drawH, borderRadius);
        ctx.clip();
        ctx.drawImage(image, imgX, imgY, drawW, drawH);
        ctx.restore();

        if (borderWidth > 0) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = borderWidth;
            roundRect(ctx, imgX, imgY, drawW, drawH, borderRadius);
            ctx.stroke();
        }

        if (measured.captionLines.length) {
            ctx.fillStyle = '#26221c';
            ctx.font = `${measured.captionFontSize}px "Noto Sans SC", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            let captionY = imgY + drawH + borderWidth + 14 + extraBottom;
            const captionBlockHeight = measured.captionLines.length * measured.captionFontSize * 1.45;
            if (glassBg !== false) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
                roundRect(
                    ctx,
                    padding,
                    captionY - 6,
                    cardW - padding * 2,
                    captionBlockHeight + 10,
                    8
                );
                ctx.fill();
            }
            ctx.fillStyle = '#26221c';
            for (const line of measured.captionLines) {
                ctx.fillText(line, cardW / 2, captionY);
                captionY += measured.captionFontSize * 1.45;
            }
        }

        if (tiltDeg) ctx.restore();

        return canvas;
    }

    function canvasToBlob(canvas, type = 'image/png', quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('生成 PNG 失败'));
            }, type, quality);
        });
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    global.StickerFrame = {
        PRESETS,
        mergeOptions,
        measureFrame,
        renderStickerFrame,
        canvasToBlob,
        blobToBase64
    };
})(typeof window !== 'undefined' ? window : globalThis);
