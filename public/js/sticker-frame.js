/**
 * Canvas renderer for Xiaohongshu / sticker-style image frames.
 * Export uses native image resolution (1:1 pixels) unless outputWidth is set.
 */
(function (global) {
    const REF_WIDTH = 390;

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

    /** Blurred same-image background — the photo itself, not a color wash. */
    function drawBlurredImageBackground(ctx, image, x, y, w, h, opts, drawW) {
        const baseBlur = Number(opts.glassBlur) || 36;
        const blurPx = baseBlur * (Math.max(w, drawW || w) / REF_WIDTH);
        const frostAlpha = Number(opts.glassFrost);
        const frost = Number.isFinite(frostAlpha) ? frostAlpha : 0.14;
        const tintAlpha = Number(opts.glassTint) || 0;

        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.ceil(w));
        off.height = Math.max(1, Math.ceil(h));
        const octx = off.getContext('2d');
        octx.filter = `blur(${blurPx}px) saturate(1.12) brightness(1.04)`;
        drawCoverImage(octx, image, 0, 0, w, h);
        octx.filter = 'none';

        ctx.save();
        roundRect(ctx, x, y, w, h, 14);
        ctx.clip();
        ctx.drawImage(off, x, y, w, h);
        if (frost > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${frost})`;
            ctx.fillRect(x, y, w, h);
        }
        if (tintAlpha > 0 && opts.bgColor) {
            ctx.fillStyle = hexToRgba(opts.bgColor, tintAlpha);
            ctx.fillRect(x, y, w, h);
        }
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

    function resolveDrawSize(image, opts) {
        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;
        if (!imgW || !imgH) {
            return { imgW: 0, imgH: 0, drawW: 0, drawH: 0, uiScale: 1 };
        }

        const padding = Number(opts.padding) || 24;
        const outputWidth = Number(opts.outputWidth);
        const previewMaxWidth = Number(opts.previewMaxWidth) || 0;

        let targetContentW;
        if (previewMaxWidth > 0) {
            targetContentW = Math.max(1, previewMaxWidth - padding * 2);
        } else if (outputWidth > 0) {
            targetContentW = Math.max(1, outputWidth - padding * 2);
        } else {
            return { imgW, imgH, drawW: imgW, drawH: imgH, uiScale: imgW / REF_WIDTH };
        }

        const scale = targetContentW / imgW;
        return {
            imgW,
            imgH,
            drawW: Math.max(1, Math.round(imgW * scale)),
            drawH: Math.max(1, Math.round(imgH * scale)),
            uiScale: targetContentW / REF_WIDTH
        };
    }

    const PRESETS = {
        xhs: {
            label: '小红书经典',
            padding: 32,
            bgColor: '#f6edda',
            glassBg: true,
            glassBlur: 36,
            glassFrost: 0.14,
            glassTint: 0,
            borderWidth: 2.5,
            borderColor: '#26221c',
            borderRadius: 12,
            shadowOffset: 3,
            shadowAlpha: 0.45,
            tiltDeg: -0.6,
            tape: true,
            captionFontSize: 14,
            outputWidth: 0
        },
        chat: {
            label: '对话条同款',
            padding: 20,
            bgColor: '#f6edda',
            glassBg: true,
            glassBlur: 28,
            glassFrost: 0.16,
            glassTint: 0,
            borderWidth: 2,
            borderColor: '#26221c',
            borderRadius: 12,
            shadowOffset: 3,
            shadowAlpha: 0.45,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        polaroid: {
            label: '拍立得',
            padding: 28,
            bgColor: '#fffdf6',
            glassBg: true,
            glassBlur: 24,
            glassFrost: 0.18,
            glassTint: 0,
            borderWidth: 2,
            borderColor: '#26221c',
            borderRadius: 4,
            shadowOffset: 4,
            shadowAlpha: 0.35,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 15,
            outputWidth: 0,
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
            outputWidth: 0
        }
    };

    function mergeOptions(options) {
        const presetKey = options?.preset && PRESETS[options.preset] ? options.preset : 'xhs';
        return { ...PRESETS[presetKey], ...options, preset: presetKey };
    }

    function scaledUi(value, uiScale, minVal) {
        const v = Math.round(Number(value) * uiScale);
        return Math.max(minVal ?? 1, v);
    }

    function measureFrame(image, options) {
        const opts = mergeOptions(options);
        const size = resolveDrawSize(image, opts);
        const { drawW, drawH, uiScale } = size;

        const padding = scaledUi(opts.padding, uiScale, 8);
        const borderWidth = scaledUi(opts.borderWidth, uiScale, 0);
        const shadowOffset = scaledUi(opts.shadowOffset, uiScale, 0);
        const borderRadius = scaledUi(opts.borderRadius, uiScale, 0);
        const extraBottom = scaledUi(opts.extraBottomPadding || 0, uiScale, 0);
        const captionFontSize = scaledUi(opts.captionFontSize, uiScale, 12);
        const caption = String(opts.caption || '').trim();

        if (!drawW || !drawH) {
            return {
                width: 100,
                height: 100,
                drawW: 80,
                drawH: 80,
                padding,
                borderWidth,
                borderRadius,
                shadowOffset,
                captionLines: [],
                captionFontSize,
                uiScale,
                opts
            };
        }

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
            borderWidth,
            borderRadius,
            shadowOffset,
            captionLines,
            captionFontSize,
            uiScale,
            opts
        };
    }

    function renderStickerFrame(image, options) {
        const measured = measureFrame(image, options);
        const opts = measured.opts;
        const {
            bgColor,
            borderColor,
            shadowAlpha,
            tiltDeg,
            tape,
            glassBg
        } = opts;

        const padding = measured.padding;
        const borderWidth = measured.borderWidth;
        const borderRadius = measured.borderRadius;
        const shadowOffset = measured.shadowOffset;
        const drawW = measured.drawW;
        const drawH = measured.drawH;
        const uiScale = measured.uiScale;
        const extraBottom = scaledUi(opts.extraBottomPadding || 0, uiScale, 0);
        const captionBlockH = measured.captionLines.length
            ? measured.captionLines.length * measured.captionFontSize * 1.45 + 12
            : 0;

        const canvasW = measured.width;
        const canvasH = measured.height;
        const cardW = drawW + borderWidth * 2 + padding * 2;
        const cardH = drawH + borderWidth * 2 + padding * 2 + extraBottom + captionBlockH;

        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const useGlass = glassBg !== false;
        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;

        if (useGlass) {
            drawBlurredImageBackground(ctx, image, 0, 0, canvasW, canvasH, opts, drawW);
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
            drawBlurredImageBackground(ctx, image, 0, 0, cardW, cardH, opts, drawW);
        } else {
            fillSolidBackground(ctx, 0, 0, cardW, cardH, bgColor);
        }

        if (tape) {
            const ts = uiScale;
            drawTape(ctx, padding + 8 * ts, padding - 6 * ts, 52 * ts, 16 * ts, 'warm');
            drawTape(ctx, cardW - padding - 60 * ts, padding - 6 * ts, 52 * ts, 16 * ts, 'default');
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
        ctx.drawImage(image, 0, 0, imgW, imgH, imgX, imgY, drawW, drawH);
        ctx.restore();

        if (borderWidth > 0) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = borderWidth;
            roundRect(ctx, imgX, imgY, drawW, drawH, borderRadius);
            ctx.stroke();
        }

        if (measured.captionLines.length) {
            ctx.font = `${measured.captionFontSize}px "Noto Sans SC", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            let captionY = imgY + drawH + borderWidth + 14 + extraBottom;
            const captionBlockHeight = measured.captionLines.length * measured.captionFontSize * 1.45;
            if (useGlass) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
                roundRect(ctx, padding, captionY - 6, cardW - padding * 2, captionBlockHeight + 10, 8);
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
