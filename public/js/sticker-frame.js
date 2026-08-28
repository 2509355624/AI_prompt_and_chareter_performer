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

    function fillSolidBackground(ctx, x, y, w, h, color, radius = 14) {
        ctx.fillStyle = color;
        roundRect(ctx, x, y, w, h, radius);
        ctx.fill();
    }

    function roundRectSketch(ctx, x, y, w, h) {
        const s = Math.min(w, h) * 0.045;
        const tl = s * 2.8;
        const tr = s * 0.75;
        const br = s * 2.4;
        const bl = s * 0.85;
        ctx.beginPath();
        ctx.moveTo(x + tl, y);
        ctx.lineTo(x + w - tr, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
        ctx.lineTo(x + w, y + h - br);
        ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
        ctx.lineTo(x + bl, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
        ctx.lineTo(x, y + tl);
        ctx.quadraticCurveTo(x, y, x + tl, y);
        ctx.closePath();
    }

    function clipFramePath(ctx, x, y, w, h, radius, borderStyle) {
        if (borderStyle === 'sketch') roundRectSketch(ctx, x, y, w, h);
        else roundRect(ctx, x, y, w, h, radius);
    }

    function strokeFramePath(ctx, x, y, w, h, radius, borderStyle) {
        clipFramePath(ctx, x, y, w, h, radius, borderStyle);
        ctx.stroke();
    }

    function drawGradientFill(ctx, x, y, w, h, colors, radius = 14) {
        ctx.save();
        roundRect(ctx, x, y, w, h, radius);
        ctx.clip();
        const g = ctx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, colors[0]);
        g.addColorStop(1, colors[1] || colors[0]);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    }

    function drawCardBackground(ctx, image, x, y, w, h, opts, drawW) {
        const radius = 14;
        const useGlass = opts.glassBg !== false && opts.bgMode !== 'solid';
        if (useGlass) {
            drawBlurredImageBackground(ctx, image, x, y, w, h, opts, drawW);
            if (opts.bgOverlay) {
                ctx.save();
                roundRect(ctx, x, y, w, h, radius);
                ctx.clip();
                ctx.fillStyle = opts.bgOverlay;
                ctx.fillRect(x, y, w, h);
                ctx.restore();
            }
            return;
        }
        if (opts.bgMode === 'gradient' && opts.bgGradient) {
            drawGradientFill(ctx, x, y, w, h, opts.bgGradient, radius);
            return;
        }
        fillSolidBackground(ctx, x, y, w, h, opts.bgColor || '#f6edda', radius);
    }

    function drawImageShadow(ctx, imgX, imgY, drawW, drawH, borderRadius, opts) {
        const mode = opts.shadowMode || 'hard';
        const offset = opts.shadowOffset || 0;
        const alpha = opts.shadowAlpha ?? 0.45;
        if (offset <= 0 && mode !== 'glow') return;

        if (mode === 'glow' && opts.glowColor) {
            ctx.save();
            ctx.shadowColor = opts.glowColor;
            ctx.shadowBlur = offset * 4;
            ctx.fillStyle = 'rgba(0,0,0,0.01)';
            roundRect(ctx, imgX, imgY, drawW, drawH, borderRadius);
            ctx.fill();
            ctx.restore();
            return;
        }

        if (mode === 'soft') {
            ctx.save();
            ctx.shadowColor = `rgba(0,0,0,${alpha})`;
            ctx.shadowBlur = offset * 3;
            ctx.shadowOffsetY = offset;
            ctx.fillStyle = 'rgba(0,0,0,0.01)';
            roundRect(ctx, imgX, imgY, drawW, drawH, borderRadius);
            ctx.fill();
            ctx.restore();
            return;
        }

        ctx.fillStyle = `rgba(38, 34, 28, ${alpha})`;
        roundRect(ctx, imgX + offset, imgY + offset, drawW, drawH, borderRadius);
        ctx.fill();
    }

    function drawTape(ctx, x, y, w, h, variant) {
        ctx.save();
        ctx.globalAlpha = variant === 'warm' ? 0.32 : 0.28;
        const colors = {
            warm: '#e8503a',
            blue: 'rgba(47,124,214,0.55)',
            yellow: 'rgba(255,235,150,0.55)',
            default: 'rgba(255, 248, 220, 0.95)'
        };
        ctx.fillStyle = colors[variant] || colors.default;
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

    const PRESET_ALIASES = { xhs: 'paper-collage' };

    const PRESETS = {
        'paper-collage': {
            label: '贴纸剪贴 · paper-collage',
            padding: 32,
            bgColor: '#f6edda',
            glassBg: true,
            glassBlur: 36,
            glassFrost: 0.14,
            borderWidth: 3,
            borderColor: '#26221c',
            borderRadius: 14,
            shadowMode: 'hard',
            shadowOffset: 5,
            shadowAlpha: 0.9,
            tiltDeg: -1.2,
            tape: true,
            tapeVariant: 'blue',
            captionFontSize: 14,
            outputWidth: 0
        },
        'sketch-note': {
            label: '手绘线稿 · sketch-note',
            padding: 28,
            bgColor: '#fbfaf5',
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 2.5,
            borderColor: '#232323',
            borderRadius: 12,
            borderStyle: 'sketch',
            shadowMode: 'hard',
            shadowOffset: 0,
            tiltDeg: -0.6,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        'apple-glass': {
            label: '苹果浅蓝玻璃 · apple-light-blue-glass',
            padding: 28,
            bgMode: 'gradient',
            bgGradient: ['#fbfdff', '#eef7ff'],
            glassBg: true,
            glassBlur: 28,
            glassFrost: 0.22,
            borderWidth: 1,
            borderColor: 'rgba(37,99,235,0.35)',
            borderRadius: 22,
            shadowMode: 'soft',
            shadowOffset: 4,
            shadowAlpha: 0.12,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        'apple-tech': {
            label: '科技发布会 · apple-tech-gradient',
            padding: 32,
            bgMode: 'gradient',
            bgGradient: ['#141210', '#000000'],
            glassBg: true,
            glassBlur: 32,
            glassFrost: 0.08,
            bgOverlay: 'rgba(0,0,0,0.52)',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.18)',
            borderRadius: 18,
            shadowMode: 'soft',
            shadowOffset: 3,
            shadowAlpha: 0.35,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        editorial: {
            label: '杂志编辑 · editorial-magazine',
            padding: 30,
            bgColor: '#faf9f6',
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 1,
            borderColor: 'rgba(0,0,0,0.12)',
            borderRadius: 0,
            shadowMode: 'hard',
            shadowOffset: 0,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        finance: {
            label: '财经演播室 · finance-studio-cards',
            padding: 28,
            bgMode: 'gradient',
            bgGradient: ['#0d1422', '#0a0e17'],
            glassBg: true,
            glassBlur: 24,
            glassFrost: 0.06,
            bgOverlay: 'rgba(10,14,23,0.62)',
            borderWidth: 1,
            borderColor: 'rgba(0,212,170,0.55)',
            borderRadius: 8,
            shadowMode: 'glow',
            shadowOffset: 8,
            glowColor: 'rgba(0,212,170,0.38)',
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        ink: {
            label: '墨蓝手稿 · ink-framework',
            padding: 30,
            bgColor: '#f7f2e7',
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 2,
            borderColor: 'rgba(47,78,121,0.65)',
            borderRadius: 6,
            shadowMode: 'soft',
            shadowOffset: 2,
            shadowAlpha: 0.08,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        manifesto: {
            label: '宣言海报 · manifesto-poster',
            padding: 28,
            bgColor: '#f2efe6',
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 3,
            borderColor: '#141414',
            borderRadius: 0,
            shadowMode: 'hard',
            shadowOffset: 0,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0
        },
        newspaper: {
            label: '档案剪报 · newspaper-evidence',
            padding: 28,
            bgColor: '#f5f0e8',
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 1,
            borderColor: 'rgba(26,26,26,0.18)',
            borderRadius: 2,
            shadowMode: 'hard',
            shadowOffset: 3,
            shadowAlpha: 0.14,
            tiltDeg: -1.0,
            tape: true,
            tapeVariant: 'yellow',
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
            borderWidth: 2,
            borderColor: '#26221c',
            borderRadius: 12,
            shadowMode: 'hard',
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
            borderWidth: 2,
            borderColor: '#26221c',
            borderRadius: 4,
            shadowMode: 'hard',
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
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 0,
            borderColor: '#26221c',
            borderRadius: 0,
            shadowMode: 'hard',
            shadowOffset: 0,
            shadowAlpha: 0,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 13,
            outputWidth: 0
        }
    };

    function mergeOptions(options) {
        let presetKey = options?.preset || 'paper-collage';
        if (PRESET_ALIASES[presetKey]) presetKey = PRESET_ALIASES[presetKey];
        if (!PRESETS[presetKey]) presetKey = 'paper-collage';
        const merged = { ...PRESETS[presetKey], ...options, preset: presetKey };
        // 预览模式跳过玻璃模糊，避免连画多张时 GPU 把末张 canvas 画黑
        const previewMaxWidth = Number(options?.previewMaxWidth) || 0;
        if (previewMaxWidth > 0) {
            merged.glassBg = false;
        }
        return merged;
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
        const shadowExtra = opts.shadowMode === 'glow'
            ? scaledUi((opts.shadowOffset || 0) * 4, uiScale, 0)
            : shadowOffset;

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
        const width = cardW + shadowExtra;
        const height = cardH + shadowExtra;

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
            tiltDeg,
            tape,
            tapeVariant,
            borderStyle
        } = opts;

        const padding = measured.padding;
        const borderWidth = measured.borderWidth;
        const borderRadius = measured.borderRadius;
        const drawW = measured.drawW;
        const drawH = measured.drawH;
        const uiScale = measured.uiScale;
        const extraBottom = scaledUi(opts.extraBottomPadding || 0, uiScale, 0);
        const useGlass = opts.glassBg !== false && opts.bgMode !== 'solid';

        const canvasW = measured.width;
        const canvasH = measured.height;
        const cardW = drawW + borderWidth * 2 + padding * 2;
        const cardH = drawH + borderWidth * 2 + padding * 2 + extraBottom + (
            measured.captionLines.length
                ? measured.captionLines.length * measured.captionFontSize * 1.45 + 12
                : 0
        );

        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const imgW = image.naturalWidth || image.width;
        const imgH = image.naturalHeight || image.height;

        drawCardBackground(ctx, image, 0, 0, canvasW, canvasH, opts, drawW);

        if (tiltDeg) {
            ctx.save();
            ctx.translate(canvasW / 2, canvasH / 2);
            ctx.rotate((Number(tiltDeg) * Math.PI) / 180);
            ctx.translate(-canvasW / 2, -canvasH / 2);
        }

        drawCardBackground(ctx, image, 0, 0, cardW, cardH, opts, drawW);

        if (tape) {
            const ts = uiScale;
            const variant = tapeVariant || 'warm';
            drawTape(ctx, padding + 8 * ts, padding - 6 * ts, 52 * ts, 16 * ts, variant);
            if (variant !== 'yellow') {
                drawTape(ctx, cardW - padding - 60 * ts, padding - 6 * ts, 52 * ts, 16 * ts, 'default');
            }
        }

        const imgX = padding;
        const imgY = padding;

        drawImageShadow(ctx, imgX, imgY, drawW, drawH, borderRadius, opts);

        ctx.save();
        clipFramePath(ctx, imgX, imgY, drawW, drawH, borderRadius, borderStyle);
        ctx.clip();
        ctx.drawImage(image, 0, 0, imgW, imgH, imgX, imgY, drawW, drawH);
        ctx.restore();

        if (borderWidth > 0) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = borderWidth;
            strokeFramePath(ctx, imgX, imgY, drawW, drawH, borderRadius, borderStyle);
        }

        if (measured.captionLines.length) {
            ctx.font = `${measured.captionFontSize}px "Noto Sans SC", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            let captionY = imgY + drawH + borderWidth + 14 + extraBottom;
            const captionBlockHeight = measured.captionLines.length * measured.captionFontSize * 1.45;
            const captionBg = opts.captionBg || (useGlass ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.72)');
            ctx.fillStyle = captionBg;
            roundRect(ctx, padding, captionY - 6, cardW - padding * 2, captionBlockHeight + 10, 8);
            ctx.fill();
            ctx.fillStyle = opts.captionColor || '#26221c';
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
