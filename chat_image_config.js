/**
 * Roleplay T2I uses 单次生图_二次超分 node settings, with hires/2x upscale off.
 */
module.exports = {
    comfyUrl: (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, ''),
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS) || 180000,
    pollMs: 800,
    imageMinVramMb: Number(process.env.IMAGE_MIN_VRAM_MB) || 9216,
    width: 544,
    height: 960,
    steps: 30,
    cfg: 3,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    denoise: 1,
    seed: -1,
    enableHires: false,
    hiresWidth: 1080,
    hiresHeight: 1920,
    hiresDenoise: 0.4,
    hiresSteps: 20,
    visionI2iEnabled: process.env.COMFYUI_VISION_I2I === '1',
    checkpointName: process.env.COMFYUI_CHECKPOINT || 'unholyDesireMixSinister_v70.safetensors',
    loras: [
        { name: 'add_contrast_XL.safetensors', strengthModel: 0.6, strengthClip: 1 },
        { name: 'add_saturation_XL.safetensors', strengthModel: 0.5, strengthClip: 1 },
        { name: 'loras\\anima-masterpieces-nlmix2-e41.safetensors', strengthModel: 0.5, strengthClip: 1 }
    ],
    stylePrefix:
        'masterpiece, best quality, ultra-detailed, absurdres, tianliang_duohe_fangdongye (0.6 weight), ciloranko, sho_(sho_lwlw) (0.8 weight), sfw',
    lightingPrefix: 'dramatic lighting, long shadows, cool color grade, dark teal and orange atmosphere',
    negativePrompt:
        'lowres, worst quality, bad anatomy, seductive posture, exaggerated twist body, leaning hips, transparent fabric, bare thighs, provocative gaze, nsfw',
    testPromptTurn:
        'school blazer and plaid skirt, loosened ribbon, holding books to chest, classroom doorway, close-up, soft warm sunlight, lens flare, cozy, endearing, subtle smile, intimate portrait-style, gentle ambiance, nostalgic',
    testPromptBase:
        '1girl, solo, white hair, twin tails, orange eyes',
    samplerOptions: [
        'euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral',
        'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde',
        'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu',
        'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ddim', 'uni_pc', 'uni_pc_bh2'
    ],
    schedulerOptions: [
        'normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal'
    ]
};
