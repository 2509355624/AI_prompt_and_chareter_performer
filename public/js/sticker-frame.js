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

    /** Blurred same-image background — blur on a small offscreen, then upscale (GPU-safe). */
    function drawBlurredImageBackground(ctx, image, x, y, w, h, opts, drawW) {
        const baseBlur = Number(opts.glassBlur) || 32;
        const maxSide = Math.max(w, h, 1);
        const isPreview = Number(opts.previewMaxWidth) > 0;
        const blurCanvasMax = isPreview ? 480 : 840;
        const shrink = Math.min(1, blurCanvasMax / maxSide);
        const offW = Math.max(1, Math.ceil(w * shrink));
        const offH = Math.max(1, Math.ceil(h * shrink));
        const blurPx = Math.min(
            56,
            Math.max(2, baseBlur * (Math.max(offW, drawW * shrink || offW) / REF_WIDTH))
        );
        const zoom = Math.max(1, Number(opts.glassZoom) || 1);

        const off = document.createElement('canvas');
        off.width = offW;
        off.height = offH;
        const octx = off.getContext('2d', { alpha: true });
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.filter = `blur(${blurPx}px) saturate(${opts.glassSaturate ?? 1.08}) brightness(${opts.glassBrightness ?? 1.02})`;
        const pad = Math.ceil(blurPx * 2);
        const drawWZoom = offW * zoom;
        const drawHZoom = offH * zoom;
        drawCoverImage(
            octx,
            image,
            (offW - drawWZoom) / 2 - pad,
            (offH - drawHZoom) / 2 - pad,
            drawWZoom + pad * 2,
            drawHZoom + pad * 2
        );
        octx.filter = 'none';

        const frostRaw = Number(opts.glassFrost);
        const frost = Number.isFinite(frostRaw) ? frostRaw : 0.05;
        const tintAlpha = Number(opts.glassTint) || 0;
        const radius = Number(opts.borderRadius) || 14;

        ctx.save();
        roundRect(ctx, x, y, w, h, radius);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(off, x, y, w, h);
        // 半透明玻璃罩：白雾强度由 glassFrost 控制（破框默认约 0.3），不是厚磨砂亚克力
        if (frost > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${frost})`;
            ctx.fillRect(x, y, w, h);
        }
        // 顶部高光，模拟玻璃反光
        const sheen = Number(opts.glassSheen);
        const sheenAlpha = Number.isFinite(sheen) ? sheen : 0.1;
        if (sheenAlpha > 0) {
            const gloss = ctx.createLinearGradient(x, y, x, y + h * 0.45);
            gloss.addColorStop(0, `rgba(255, 255, 255, ${sheenAlpha})`);
            gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = gloss;
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

    /**
     * 抠图角色绘制：可缩放（默认底部锚定，方便凳脚/裙摆贴框底）+ 可选边缘阴影（景深感）
     */
    function resolveSubjectDrawRect(imgX, imgY, drawW, drawH, opts) {
        const raw = Number(opts.popOutSubjectScale ?? opts.subjectScale);
        const scale = Number.isFinite(raw) ? Math.min(1.8, Math.max(0.5, raw)) : 1;
        const w = drawW * scale;
        const h = drawH * scale;
        const x = imgX + (drawW - w) / 2;
        const anchor = String(opts.subjectAnchor || 'bottom');
        let y;
        if (anchor === 'center') {
            y = imgY + (drawH - h) / 2;
        } else if (anchor === 'top') {
            y = imgY;
        } else {
            // bottom：放大时向下伸，更容易跟黑框下边对齐
            y = imgY + drawH - h;
        }
        return { x, y, w, h, scale };
    }

    function drawMatteLayer(ctx, matteFg, imgX, imgY, drawW, drawH, opts) {
        const fgW = matteFg.naturalWidth || matteFg.width;
        const fgH = matteFg.naturalHeight || matteFg.height;
        if (!fgW || !fgH) return;
        const rect = resolveSubjectDrawRect(imgX, imgY, drawW, drawH, opts);
        const shadowBlurRaw = Number(opts.subjectShadowBlur);
        const blur = Number.isFinite(shadowBlurRaw)
            ? Math.max(0, shadowBlurRaw)
            : (opts.subjectShadow === false ? 0 : 16);

        ctx.save();
        if (blur > 0) {
            ctx.shadowColor = opts.subjectShadowColor || 'rgba(0, 0, 0, 0.42)';
            ctx.shadowBlur = blur;
            ctx.shadowOffsetX = Number(opts.subjectShadowOffsetX) || 0;
            ctx.shadowOffsetY = Number.isFinite(Number(opts.subjectShadowOffsetY))
                ? Number(opts.subjectShadowOffsetY)
                : Math.max(2, Math.round(blur * 0.28));
        }
        ctx.drawImage(matteFg, 0, 0, fgW, fgH, rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
    }

    /**
     * 破框最底层舞台：
     * frost = 磨砂原图（现状）
     * letterbox = 横向大黑边（上下黑，中间可留磨砂图）
     * pillarbox = 竖向大黑边（左右黑）
     * black = 全黑舞台（角色破框压在纯黑上，最像抖音裸眼 3D）
     */
    function drawPopOutStageBackground(ctx, image, x, y, w, h, opts, drawW, radius) {
        const mode = String(opts.popOutStageMode || 'frost');
        const bgOpacityRaw = Number(opts.popOutBgOpacity);
        const bgFrost = Number.isFinite(bgOpacityRaw)
            ? Math.min(0.8, Math.max(0, bgOpacityRaw))
            : 0.3;
        const frostOpts = {
            ...opts,
            borderRadius: radius || 0,
            glassBlur: Number(opts.popOutOuterBlur) || 14,
            glassFrost: bgFrost,
            glassSheen: Math.min(0.1, 0.02 + bgFrost * 0.1),
            glassZoom: 1.04,
            glassBrightness: 1.0,
            glassSaturate: 1.02,
            glassTint: 0
        };

        if (mode === 'black' || mode === 'letterbox' || mode === 'pillarbox') {
            ctx.fillStyle = '#000000';
            if (radius > 0) {
                roundRect(ctx, x, y, w, h, radius);
                ctx.fill();
            } else {
                ctx.fillRect(x, y, w, h);
            }

            if (mode === 'black') return;

            const barRaw = Number(opts.popOutBlackBar);
            const bar = Number.isFinite(barRaw) ? Math.min(0.4, Math.max(0.1, barRaw)) : 0.22;
            let ix = x;
            let iy = y;
            let iw = w;
            let ih = h;
            if (mode === 'letterbox') {
                const barH = h * bar;
                iy = y + barH;
                ih = Math.max(1, h - barH * 2);
            } else {
                const barW = w * bar;
                ix = x + barW;
                iw = Math.max(1, w - barW * 2);
            }
            if (iw > 8 && ih > 8) {
                drawBlurredImageBackground(ctx, image, ix, iy, iw, ih, {
                    ...frostOpts,
                    borderRadius: Math.min(radius || 0, 8)
                }, drawW);
            }
            return;
        }

        // frost（默认）
        drawBlurredImageBackground(ctx, image, x, y, w, h, frostOpts, drawW);
    }

    /**
     * 破框图层（从下到上）：
     * 0) 整卡背景板 = 原图（浅模糊 + 可调白雾）——外面已画
     * 1) 空心黑框 = 只有描边，框内什么都不画（透过空洞看见背景板）
     * 2) 整层抠图最上 → 压住黑边；手/发伸出框外 = 裸眼 3D
     *
     * 切勿在框内再画一遍原图：半透明裙/发会透出「第二层角色」，像框穿模。
     */
    function drawPopOutScene(
        ctx,
        image,
        matteFg,
        imgX,
        imgY,
        drawW,
        drawH,
        borderRadius,
        borderStyle,
        borderWidth,
        borderColor,
        opts
    ) {
        const frameScale = Number(opts.popOutFrameScale) || 0.5;
        const windowW = drawW * frameScale;
        const windowH = drawH * frameScale;
        const freeY = Math.max(0, drawH - windowH);
        // offsetY: -1 框贴顶，+1 框贴底，0 居中。默认略上移，让下边框更容易被角色挡住
        const offsetY = Number(opts.popOutFrameOffsetY);
        const offsetNorm = Number.isFinite(offsetY) ? Math.max(-1, Math.min(1, offsetY)) : -0.25;
        const windowX = imgX + (drawW - windowW) / 2;
        const windowY = imgY + freeY * (0.5 + offsetNorm * 0.5);
        const winRadius = Math.max(6, Math.round(borderRadius * frameScale));
        const strokeW = Math.max(2, Number(borderWidth) || 3);

        // 空心黑框：只描边，框内留空看背景板
        ctx.save();
        ctx.strokeStyle = borderColor || '#26221c';
        ctx.lineWidth = strokeW;
        ctx.lineJoin = 'round';
        strokeFramePath(ctx, windowX, windowY, windowW, windowH, winRadius, borderStyle);
        ctx.restore();

        // 抠图层最上（可缩放 + 边缘阴影）
        drawMatteLayer(ctx, matteFg, imgX, imgY, drawW, drawH, opts);
    }

    function drawDofInsideFrame(ctx, image, matteFg, imgX, imgY, drawW, drawH, opts) {
        drawBlurredImageBackground(ctx, image, imgX, imgY, drawW, drawH, {
            ...opts,
            borderRadius: opts.borderRadius || 14,
            glassBlur: Number(opts.dofBlur) || 38,
            glassFrost: opts.dofFrost ?? 0.03,
            glassSheen: opts.glassSheen ?? 0.1,
            glassZoom: opts.glassZoom ?? 1.06,
            glassTint: 0
        }, drawW);
        drawMatteLayer(ctx, matteFg, imgX, imgY, drawW, drawH, opts);
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

    const PRESET_ALIASES = { xhs: 'paper-collage', plain: 'none', raw: 'none' };

    const PRESETS = {
        none: {
            label: '无边框 · 原图',
            padding: 0,
            bgColor: '#000000',
            bgMode: 'solid',
            glassBg: false,
            borderWidth: 0,
            borderColor: 'transparent',
            borderRadius: 0,
            shadowMode: 'hard',
            shadowOffset: 0,
            shadowAlpha: 0,
            tiltDeg: 0,
            tape: false,
            captionFontSize: 14,
            outputWidth: 0,
            plain: true
        },
        'paper-collage': {
            label: '贴纸剪贴 · paper-collage',
            padding: 32,
            bgColor: '#f6edda',
            glassBg: true,
            glassBlur: 32,
            glassFrost: 0.05,
            glassSheen: 0.1,
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
        // 预览保留玻璃模糊；模糊本身在小画布上完成（见 drawBlurredImageBackground）
        return merged;
    }

    function scaledUi(value, uiScale, minVal) {
        const v = Math.round(Number(value) * uiScale);
        return Math.max(minVal ?? 1, v);
    }

    function measureFrame(image, options) {
        const opts = mergeOptions(options);
        if (opts.plain || opts.preset === 'none') {
            const size = resolveDrawSize(image, opts);
            const drawW = Math.max(1, size.drawW || 1);
            const drawH = Math.max(1, size.drawH || 1);
            return {
                width: drawW,
                height: drawH,
                drawW,
                drawH,
                padding: 0,
                borderWidth: 0,
                borderRadius: 0,
                shadowOffset: 0,
                captionLines: [],
                captionFontSize: 14,
                uiScale: size.uiScale || 1,
                opts
            };
        }
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

        const usePopOut = !!(opts.popOut && opts.depthOfField);
        const stageMode = String(opts.popOutStageMode || 'frost');
        const blackStage = stageMode === 'black' || stageMode === 'letterbox' || stageMode === 'pillarbox';
        const overflow = Number(opts.popOutOverflow) || (blackStage ? 0.18 : 0.12);
        const popPadTop = usePopOut ? Math.ceil(drawH * overflow) : 0;
        const popPadBottom = usePopOut && blackStage ? Math.ceil(drawH * overflow * 0.85) : 0;
        const sideRatio = blackStage && stageMode === 'pillarbox' ? 0.12 : 0.05;
        const popPadSides = usePopOut ? Math.ceil(drawW * sideRatio) : 0;

        const innerW = drawW + borderWidth * 2;
        const innerH = drawH + borderWidth * 2;
        const cardW = innerW + padding * 2 + popPadSides * 2;
        const cardH = innerH + padding * 2 + extraBottom + captionBlockH + popPadTop + popPadBottom;
        const width = cardW + shadowExtra + popPadSides * 2;
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
            popPadTop,
            popPadBottom,
            popPadSides,
            captionLines,
            captionFontSize,
            uiScale,
            opts
        };
    }

    function renderPlainImage(image, options) {
        const measured = measureFrame(image, { ...(options || {}), preset: 'none' });
        const canvas = document.createElement('canvas');
        canvas.width = measured.drawW;
        canvas.height = measured.drawH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const imgW = image.naturalWidth || image.width || measured.drawW;
        const imgH = image.naturalHeight || image.height || measured.drawH;
        ctx.drawImage(image, 0, 0, imgW, imgH, 0, 0, measured.drawW, measured.drawH);
        return canvas;
    }

    function renderStickerFrame(image, options) {
        const measured = measureFrame(image, options);
        const opts = measured.opts;
        if (opts.plain || opts.preset === 'none') {
            return renderPlainImage(image, options);
        }
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
        const popPadTop = measured.popPadTop || 0;
        const popPadBottom = measured.popPadBottom || 0;
        const popPadSides = measured.popPadSides || 0;
        const cardW = drawW + borderWidth * 2 + padding * 2 + popPadSides * 2;
        const cardH = drawH + borderWidth * 2 + padding * 2 + extraBottom + popPadTop + popPadBottom + (
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

        const matteFg = opts.matteForeground;
        const useDof = opts.depthOfField && matteFg && (matteFg.naturalWidth || matteFg.width);
        const usePopOut = useDof && opts.popOut;

        // 破框最底层：磨砂原图 / 横向黑边 / 竖向黑边 / 全黑
        if (usePopOut) {
            drawPopOutStageBackground(ctx, image, 0, 0, canvasW, canvasH, opts, drawW, 0);
        } else {
            drawCardBackground(ctx, image, 0, 0, canvasW, canvasH, opts, drawW);
        }

        if (tiltDeg) {
            ctx.save();
            ctx.translate(canvasW / 2, canvasH / 2);
            ctx.rotate((Number(tiltDeg) * Math.PI) / 180);
            ctx.translate(-canvasW / 2, -canvasH / 2);
        }

        if (usePopOut) {
            drawPopOutStageBackground(ctx, image, 0, 0, cardW, cardH, opts, drawW, 14);
        } else {
            drawCardBackground(ctx, image, 0, 0, cardW, cardH, opts, drawW);
        }

        if (tape) {
            const ts = uiScale;
            const variant = tapeVariant || 'warm';
            drawTape(ctx, padding + 8 * ts, padding - 6 * ts, 52 * ts, 16 * ts, variant);
            if (variant !== 'yellow') {
                drawTape(ctx, cardW - padding - 60 * ts, padding - 6 * ts, 52 * ts, 16 * ts, 'default');
            }
        }

        const imgX = padding + popPadSides;
        const imgY = padding + popPadTop;

        if (usePopOut) {
            drawPopOutScene(
                ctx,
                image,
                matteFg,
                imgX,
                imgY,
                drawW,
                drawH,
                borderRadius,
                borderStyle,
                borderWidth,
                borderColor,
                opts
            );
        } else {
            drawImageShadow(ctx, imgX, imgY, drawW, drawH, borderRadius, opts);
            ctx.save();
            clipFramePath(ctx, imgX, imgY, drawW, drawH, borderRadius, borderStyle);
            ctx.clip();
            if (useDof) {
                drawDofInsideFrame(ctx, image, matteFg, imgX, imgY, drawW, drawH, opts);
            } else {
                ctx.drawImage(image, 0, 0, imgW, imgH, imgX, imgY, drawW, drawH);
            }
            ctx.restore();

            if (borderWidth > 0) {
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = borderWidth;
                strokeFramePath(ctx, imgX, imgY, drawW, drawH, borderRadius, borderStyle);
            }
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

    /** 上半正常、下半发黑：GPU/canvas 在大图 + blur 时的典型故障 */
    function isCanvasCorrupt(canvas) {
        if (!canvas || !canvas.width || !canvas.height) return true;
        try {
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            const samples = [
                [0.2, 0.12, 0.6, 0.35],
                [0.2, 0.55, 0.6, 0.35]
            ];
            for (const [rx, ry, rw, rh] of samples) {
                const x0 = Math.floor(w * rx);
                const y0 = Math.floor(h * ry);
                const sw = Math.max(1, Math.floor(w * rw));
                const sh = Math.max(1, Math.floor(h * rh));
                const data = ctx.getImageData(x0, y0, sw, sh).data;
                let dark = 0;
                let total = 0;
                for (let i = 0; i < data.length; i += 16) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];
                    if (a < 12) continue;
                    total += 1;
                    if (r + g + b < 48) dark += 1;
                }
                if (total > 24 && dark / total > 0.82) return true;
            }
            return false;
        } catch (_) {
            return false;
        }
    }

    function downscaleImage(image, maxW) {
        const imgW = image.naturalWidth || image.width || 0;
        const imgH = image.naturalHeight || image.height || 0;
        if (!maxW || !imgW || imgW <= maxW) return image;
        const scale = maxW / imgW;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(imgW * scale));
        canvas.height = Math.max(1, Math.round(imgH * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    /**
     * 安全渲染：全分辨率失败（下半发黑）时降采样 / 关玻璃模糊重试。
     * @returns {{ canvas: HTMLCanvasElement, degraded: boolean, reason: string }}
     */
    function renderStickerFrameSafe(image, options = {}) {
        const baseOpts = { ...(options || {}) };
        let canvas = renderStickerFrame(image, baseOpts);
        if (!isCanvasCorrupt(canvas)) {
            return { canvas, degraded: false, reason: '' };
        }

        const caps = [1600, 1280, 960, 720];
        for (const cap of caps) {
            const source = downscaleImage(image, cap);
            canvas = renderStickerFrame(source, {
                ...baseOpts,
                previewMaxWidth: Math.min(Number(baseOpts.previewMaxWidth) || cap, cap),
                outputWidth: 0
            });
            if (!isCanvasCorrupt(canvas)) {
                return { canvas, degraded: true, reason: `downscale_${cap}` };
            }
        }

        canvas = renderStickerFrame(downscaleImage(image, 1280), {
            ...baseOpts,
            glassBg: false,
            previewMaxWidth: 1280,
            outputWidth: 0
        });
        if (!isCanvasCorrupt(canvas)) {
            return { canvas, degraded: true, reason: 'no_glass' };
        }

        return { canvas, degraded: true, reason: 'still_corrupt' };
    }

    global.StickerFrame = {
        PRESETS,
        STAGE_MODES: {
            frost: '磨砂原图',
            letterbox: '横向大黑边',
            pillarbox: '竖向大黑边',
            black: '全黑舞台'
        },
        mergeOptions,
        measureFrame,
        renderStickerFrame,
        renderStickerFrameSafe,
        isCanvasCorrupt,
        downscaleImage,
        canvasToBlob,
        blobToBase64
    };
})(typeof window !== 'undefined' ? window : globalThis);
