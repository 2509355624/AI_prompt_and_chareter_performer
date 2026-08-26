const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sha1Hex(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function hmacSha256(key, input, outputEncoding) {
  return crypto.createHmac("sha256", key).update(input).digest(outputEncoding);
}

function toUtcAmzDate(date = new Date()) {
  const iso = date.toISOString();
  const ymd = iso.slice(0, 10).replaceAll("-", "");
  const hms = iso.slice(11, 19).replaceAll(":", "");
  return `${ymd}T${hms}Z`;
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalizeQuery(query) {
  const pairs = Object.entries(query)
    .flatMap(([k, v]) => {
      if (v === undefined || v === null) return [];
      if (Array.isArray(v)) return v.map((vv) => [k, String(vv)]);
      return [[k, String(v)]];
    })
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)]);

  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function normalizeHeaderValue(v) {
  return String(v).trim().replace(/\s+/g, " ");
}

function volcSignHeaders({ method, host, path, query, headers, body, accessKeyId, secretAccessKey, region, service }) {
  const amzDate = headers["X-Date"] || headers["x-date"] || toUtcAmzDate();
  const shortDate = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(body || "");
  const mergedHeaders = {
    ...headers,
    Host: host,
    "X-Date": amzDate,
    "X-Content-Sha256": payloadHash,
  };

  const lowerHeaderEntries = Object.entries(mergedHeaders).map(([k, v]) => [k.toLowerCase(), normalizeHeaderValue(v)]);
  lowerHeaderEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = lowerHeaderEntries.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = lowerHeaderEntries.map(([k]) => k).join(";");
  const canonicalQuery = canonicalizeQuery(query || {});
  const canonicalRequest = [
    method.toUpperCase(),
    path || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmacSha256(secretAccessKey, shortDate, undefined);
  const kRegion = hmacSha256(kDate, region, undefined);
  const kService = hmacSha256(kRegion, service, undefined);
  const kSigning = hmacSha256(kService, "request", undefined);
  const signature = hmacSha256(kSigning, stringToSign, "hex");

  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...mergedHeaders,
    Authorization: authorization,
  };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function requireValue(name, v) {
  if (!v) throw new Error(`缺少参数：${name}`);
  return v;
}

function parseJsonStringOrNull(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function base64StdEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf.toString("base64");
}

function safeJoinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

function encodePathPreserveSlash(path) {
  return String(path)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

async function downloadToFile(url, outPath) {
  const resp = await axios.get(url, { responseType: "stream", timeout: 300_000 });
  await fs.promises.mkdir(require("path").dirname(outPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    resp.data.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
  return outPath;
}

function qiniuUploadToken({ accessKey, secretKey, bucket, key, expiresSec = 3600 }) {
  const deadline = Math.floor(Date.now() / 1000) + expiresSec;
  const putPolicy = { scope: `${bucket}:${key}`, deadline };
  const encodedPolicy = base64UrlEncode(JSON.stringify(putPolicy));
  const sign = crypto.createHmac("sha1", secretKey).update(encodedPolicy).digest();
  const encodedSign = base64UrlEncode(sign);
  return `${accessKey}:${encodedSign}:${encodedPolicy}`;
}

function qiniuManagementAuth({ accessKey, secretKey, pathWithQuery }) {
  const signingStr = `${pathWithQuery}\n`;
  const sign = crypto.createHmac("sha1", secretKey).update(signingStr).digest();
  const encodedSign = base64StdEncode(sign);
  return `QBox ${accessKey}:${encodedSign}`;
}

function qiniuPrivateDownloadUrl({ accessKey, secretKey, baseUrl, expiresSec = 3600 }) {
  const deadline = Math.floor(Date.now() / 1000) + expiresSec;
  const separator = String(baseUrl).includes("?") ? "&" : "?";
  const unsignedUrl = `${baseUrl}${separator}e=${deadline}`;
  const sign = crypto.createHmac("sha1", secretKey).update(unsignedUrl).digest();
  const encodedSign = base64UrlEncode(sign);
  return `${unsignedUrl}&token=${accessKey}:${encodedSign}`;
}

async function qiniuListBuckets({ accessKey, secretKey }) {
  const host = "rs.qiniu.com";
  const pathWithQuery = "/buckets";
  const url = `https://${host}${pathWithQuery}`;
  const authorization = qiniuManagementAuth({ accessKey, secretKey, pathWithQuery });
  const resp = await axios.get(url, {
    headers: { Authorization: authorization },
    timeout: 30_000,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  if (!Array.isArray(resp.data)) return [];
  return resp.data;
}

async function qiniuPutb64Upload({ uploadEndpoint, uploadToken, key, dataBuffer }) {
  const encodedKey = base64UrlEncode(key);
  const url = safeJoinUrl(uploadEndpoint, `/putb64/-1/key/${encodedKey}`);
  const body = dataBuffer.toString("base64");

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `UpToken ${uploadToken}`,
      "Content-Type": "application/octet-stream",
    },
    timeout: 300_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return resp.data;
}

async function qiniuFormUpload({ uploadEndpoint, uploadToken, key, dataBuffer, fileName }) {
  const url = `${String(uploadEndpoint || "").replace(/\/+$/, "")}/`;
  const form = new FormData();
  form.append("token", uploadToken);
  form.append("key", key);
  form.append("file", new Blob([dataBuffer]), fileName || "file");

  const resp = await fetch(url, { method: "POST", body: form });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`七牛上传失败：status=${resp.status} body=${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

async function qiniuUploadFileToPublicUrl({
  accessKey,
  secretKey,
  bucket,
  domain,
  publicScheme = "http",
  isPrivateBucket = false,
  privateUrlExpiresSec = 3600,
  uploadEndpoint,
  keyPrefix,
  localPath,
  fixedKey,
  dataBuffer,
}) {
  const buf = dataBuffer || fs.readFileSync(localPath);
  const ext = String(localPath.split(".").pop() || "").toLowerCase();
  const key = fixedKey || `${keyPrefix}${randomId()}${ext ? `.${ext}` : ""}`;
  const token = qiniuUploadToken({ accessKey, secretKey, bucket, key });
  await qiniuFormUpload({ uploadEndpoint, uploadToken: token, key, dataBuffer: buf, fileName: key.split("/").pop() });
  const baseUrl = `${publicScheme}://${domain}/${encodePathPreserveSlash(key)}`;
  if (isPrivateBucket) {
    return qiniuPrivateDownloadUrl({ accessKey, secretKey, baseUrl, expiresSec: privateUrlExpiresSec });
  }
  return baseUrl;
}

async function qiniuHeadPublicDomain({ domain, publicScheme = "http" }) {
  const url = `${publicScheme}://${domain}/`;
  try {
    const resp = await axios.head(url, { timeout: 10_000, validateStatus: () => true });
    return { ok: true, status: resp.status, url };
  } catch (e) {
    return { ok: false, error: String(e.message || e), url };
  }
}

async function voiceCloneUploadAndWait({ token, appid, resourceId, speakerId, trainAudioPath, language = 0, modelType = 5 }) {
  const audioBytes = fs.readFileSync(trainAudioPath);
  const audioB64 = Buffer.from(audioBytes).toString("base64");
  const audioFormat = String(trainAudioPath.split(".").pop() || "").toLowerCase() || "wav";

  const uploadUrl = "https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload";
  const statusUrl = "https://openspeech.bytedance.com/api/v1/mega_tts/status";
  const headers = {
    Authorization: `Bearer;${token}`,
    "Resource-Id": resourceId,
    "Content-Type": "application/json",
  };

  const uploadBody = {
    appid,
    speaker_id: speakerId,
    audios: [{ audio_bytes: audioB64, audio_format: audioFormat }],
    source: 2,
    language,
    model_type: modelType,
    extra_params: "{}",
  };

  const uploadResp = await axios.post(uploadUrl, uploadBody, { headers, timeout: 120_000 });
  if (uploadResp.data?.BaseResp?.StatusCode !== 0) {
    throw new Error(`声音复刻上传失败：${JSON.stringify(uploadResp.data)}`);
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(10_000);
    const statusResp = await axios.post(statusUrl, { appid, speaker_id: speakerId }, { headers, timeout: 60_000 });
    const code = statusResp.data?.BaseResp?.StatusCode;
    if (code !== 0) {
      throw new Error(`声音复刻状态查询失败：${JSON.stringify(statusResp.data)}`);
    }
    const status = statusResp.data?.status;
    if (status === 2 || status === 4) return statusResp.data;
    if (status === 3) throw new Error(`声音复刻训练失败：${JSON.stringify(statusResp.data)}`);
  }

  throw new Error("声音复刻超时：超过最大轮询次数");
}

async function openspeechTtsToBuffer({ appid, accessToken, resourceId, speakerId, text, format = "mp3", sampleRate = 24000 }) {
  const url = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
  const headers = {
    "Content-Type": "application/json",
    "X-Api-App-Id": String(appid),
    "X-Api-Access-Key": String(accessToken),
    "X-Api-Resource-Id": String(resourceId),
    "X-Api-Request-Id": randomId(),
  };

  const body = {
    user: { uid: "demo" },
    namespace: "BidirectionalTTS",
    req_params: {
      text,
      speaker: speakerId,
      audio_params: {
        format,
        sample_rate: Number(sampleRate),
      },
    },
  };

  const resp = await axios.post(url, body, {
    headers,
    responseType: "stream",
    timeout: 300_000,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const buffers = [];
  let pending = "";
  const marker = "\"data\":\"";

  await new Promise((resolve, reject) => {
    resp.data.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      while (true) {
        const start = pending.indexOf(marker);
        if (start < 0) break;
        const b64Start = start + marker.length;
        const endQuote = pending.indexOf("\"", b64Start);
        if (endQuote < 0) break;
        const b64 = pending.slice(b64Start, endQuote);
        if (b64) buffers.push(Buffer.from(b64, "base64"));
        pending = pending.slice(endQuote + 1);
      }
    });
    resp.data.on("end", resolve);
    resp.data.on("error", reject);
  });

  if (buffers.length === 0) {
    throw new Error("TTS返回未解析到音频数据（可能是鉴权/参数问题或返回格式变化）");
  }
  return Buffer.concat(buffers);
}

async function postWithRetry(url, body, config, { maxAttempts = 5, baseDelayMs = 5_000, retryOnStatuses = [429] } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.post(url, body, config);
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (!retryOnStatuses.includes(status) || attempt === maxAttempts) {
        throw error;
      }
      const retryAfterHeader = error?.response?.headers?.["retry-after"];
      const retryAfterMs = Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : 0;
      const waitMs = Math.max(baseDelayMs * attempt, retryAfterMs);
      console.log(`   请求被限流 status=${status}，第 ${attempt}/${maxAttempts} 次重试前等待 ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function cvSubmitTask({ accessKeyId, secretAccessKey, reqKey, payload, region = "cn-north-1", service = "cv" }) {
  const host = "visual.volcengineapi.com";
  const url = `https://${host}/`;
  const query = { Action: "CVSubmitTask", Version: "2022-08-31" };
  const body = JSON.stringify({ req_key: reqKey, ...payload });
  const headers = volcSignHeaders({
    method: "POST",
    host,
    path: "/",
    query,
    headers: { "Content-Type": "application/json" },
    body,
    accessKeyId,
    secretAccessKey,
    region,
    service,
  });

  const resp = await postWithRetry(
    url,
    body,
    { headers, params: query, timeout: 120_000 },
    { maxAttempts: 8, baseDelayMs: 15_000, retryOnStatuses: [429] }
  );
  if (resp.data?.code !== 10000) {
    throw new Error(`CVSubmitTask失败：${JSON.stringify(resp.data)}`);
  }
  return requireValue("task_id", resp.data?.data?.task_id);
}

async function cvGetResult({ accessKeyId, secretAccessKey, reqKey, taskId, region = "cn-north-1", service = "cv", reqJson }) {
  const host = "visual.volcengineapi.com";
  const url = `https://${host}/`;
  const query = { Action: "CVGetResult", Version: "2022-08-31" };
  const bodyObj = { req_key: reqKey, task_id: taskId };
  if (reqJson) bodyObj.req_json = reqJson;
  const body = JSON.stringify(bodyObj);

  const headers = volcSignHeaders({
    method: "POST",
    host,
    path: "/",
    query,
    headers: { "Content-Type": "application/json" },
    body,
    accessKeyId,
    secretAccessKey,
    region,
    service,
  });

  const resp = await axios.post(url, body, {
    headers,
    params: query,
    timeout: 120_000,
    validateStatus: () => true,
  });
  if (resp.status >= 500) {
    return { __http_error: true, http_status: resp.status, http_body: resp.data };
  }
  return resp.data;
}

async function cvPollDone({
  accessKeyId,
  secretAccessKey,
  reqKey,
  taskId,
  maxAttempts = 60,
  intervalMs = 5_000,
  maxHttpErrors = Infinity,
}) {
  let lastStatus = null;
  let httpErrorCount = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const data = await cvGetResult({ accessKeyId, secretAccessKey, reqKey, taskId });
    if (data?.__http_error) {
      httpErrorCount += 1;
      console.log(`   [${reqKey}] http_status=${data.http_status}，稍后重试...`);
      if (httpErrorCount >= maxHttpErrors) {
        throw new Error(`[${reqKey}] 连续服务端错误过多：task_id=${taskId} http_status=${data.http_status} body=${JSON.stringify(data.http_body)}`);
      }
      await sleep(intervalMs);
      continue;
    }
    httpErrorCount = 0;
    if (data?.code !== 10000) throw new Error(`CVGetResult失败：${JSON.stringify(data)}`);
    const status = data?.data?.status;
    if (status !== lastStatus || attempt === 0 || attempt % 6 === 0) {
      console.log(`   [${reqKey}] status=${status} attempt=${attempt + 1}/${maxAttempts}`);
      lastStatus = status;
    }
    if (status === "done") return data;
    if (status === "not_found" || status === "expired") throw new Error(`任务不可用：${status} - ${JSON.stringify(data)}`);
    await sleep(intervalMs);
  }
  throw new Error("CV任务超时：超过最大轮询次数");
}

function getFlowConfigs(flowArg) {
  const flow = String(flowArg || "85621").toLowerCase();
  const configs = {
    "85621": {
      name: "85621-数字人快速模式",
      subjectReqKey: "jimeng_realman_avatar_picture_create_role_omni",
      videoReqKey: "jimeng_realman_avatar_picture_omni_v2",
      needsResourceId: false,
    },
    "86081-basic": {
      name: "86081-普通模式",
      subjectReqKey: "realman_avatar_picture_create_role",
      videoReqKey: "realman_avatar_picture_v2",
      needsResourceId: true,
    },
    "86081-loopy": {
      name: "86081-灵动模式",
      subjectReqKey: "realman_avatar_picture_create_role_loopy",
      videoReqKey: "realman_avatar_picture_v2_loopy",
      needsResourceId: true,
    },
  };

  if (flow === "all") {
    return [configs["85621"], configs["86081-basic"], configs["86081-loopy"]];
  }
  if (!configs[flow]) {
    throw new Error(`不支持的 flow：${flow}，可选值：85621、86081-basic、86081-loopy、all`);
  }
  return [configs[flow]];
}

async function runAvatarFlow({ cfg, accessKeyId, secretAccessKey, imageUrl, driveAudioUrl }) {
  console.log(`3) 尝试链路：${cfg.name}`);
  console.log("   提交形象/主体任务...");
  const subjectTaskId = await cvSubmitTask({
    accessKeyId,
    secretAccessKey,
    reqKey: cfg.subjectReqKey,
    payload: { image_url: imageUrl },
  });
  console.log(`   subject task_id=${subjectTaskId}`);

  console.log("   轮询形象/主体结果...");
  const subjectResult = await cvPollDone({
    accessKeyId,
    secretAccessKey,
    reqKey: cfg.subjectReqKey,
    taskId: subjectTaskId,
    maxAttempts: 600,
    intervalMs: 1_000,
    maxHttpErrors: 20,
  });
  const subjectRespData = parseJsonStringOrNull(subjectResult?.data?.resp_data) || {};

  let videoPayload;
  if (cfg.needsResourceId) {
    const resourceId = subjectRespData?.resource_id;
    requireValue(`${cfg.name} resource_id`, resourceId);
    console.log(`   resource_id=${resourceId}`);
    videoPayload = { resource_id: resourceId, audio_url: driveAudioUrl };
  } else {
    const subjectStatus = subjectRespData?.status;
    if (subjectStatus !== 1) {
      throw new Error(`主体识别未通过：resp_data=${JSON.stringify(subjectRespData)} raw=${subjectResult?.data?.resp_data || ""}`);
    }
    console.log(`   subject_status=${subjectStatus}`);
    videoPayload = { image_url: imageUrl, audio_url: driveAudioUrl };
  }

  console.log("   提交视频生成任务...");
  const videoTaskId = await cvSubmitTask({
    accessKeyId,
    secretAccessKey,
    reqKey: cfg.videoReqKey,
    payload: videoPayload,
  });
  console.log(`   video task_id=${videoTaskId}`);

  console.log("   轮询视频生成结果...");
  const videoResult = await cvPollDone({
    accessKeyId,
    secretAccessKey,
    reqKey: cfg.videoReqKey,
    taskId: videoTaskId,
    maxAttempts: 900,
    intervalMs: 2_000,
    maxHttpErrors: 20,
  });
  const videoRespData = parseJsonStringOrNull(videoResult?.data?.resp_data) || {};
  const videoUrl = videoResult?.data?.video_url || videoRespData?.video_url || videoRespData?.preview_url || null;
  return { subjectTaskId, videoTaskId, subjectResult, videoResult, videoUrl };
}

async function queryExistingTask({ accessKeyId, secretAccessKey, reqKey, taskId, outDir, outVideo }) {
  console.log(`查询已有任务：req_key=${reqKey} task_id=${taskId}`);
  const result = await cvPollDone({
    accessKeyId,
    secretAccessKey,
    reqKey,
    taskId,
    maxAttempts: 900,
    intervalMs: 2_000,
    maxHttpErrors: 20,
  });
  const respData = parseJsonStringOrNull(result?.data?.resp_data) || {};
  const videoUrl = result?.data?.video_url || respData?.video_url || respData?.preview_url || respData?.url || null;
  console.log(`任务状态=${result?.data?.status}`);
  if (videoUrl) {
    console.log(`video_url=${videoUrl}`);
    const finalOutVideo = outVideo || `${outDir}/avatar_query_${randomId()}.mp4`;
    console.log(`下载视频到本地：${finalOutVideo}`);
    await downloadToFile(videoUrl, finalOutVideo);
    console.log(`saved=${finalOutVideo}`);
  } else {
    console.log(`原始响应：${JSON.stringify(result)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      [
        "用法：",
        "  node tests/volc_demo_voiceclone_avatar_video.js --image-file <path> --tts-text <text> --speaker-id <S_xxx>",
        "  node tests/volc_demo_voiceclone_avatar_video.js --image-url <http://...> --audio-url <http://...>",
        "",
        "flow 选择：",
        "  --flow 85621         数字人快速模式 OmniHuman1.0",
        "  --flow 86081-basic   单图音频驱动普通模式",
        "  --flow 86081-loopy   单图音频驱动灵动模式",
        "  --flow all           依次尝试以上三条链路",
        "",
        "必要环境变量（或用同名参数传入）- Visual(CV)",
        "  VOLC_VISUAL_ACCESS_KEY_ID",
        "  VOLC_VISUAL_SECRET_ACCESS_KEY",
        "",
        "必要环境变量（或用同名参数传入）- OpenSpeech(TTS)",
        "  VOLC_OPEN_SPEECH_APPID",
        "  VOLC_OPEN_SPEECH_TOKEN (旧版控制台 Access Token，用于 X-Api-Access-Key)",
        "  VOLC_OPEN_SPEECH_SPEAKER_ID",
        "",
        "可选环境变量",
        "  VOLC_OPEN_SPEECH_TTS_RESOURCE_ID (默认 seed-icl-2.0)",
        "",
        "七牛上传（当使用 --image-file / 需要上传音频时必填）",
        "  QINIU_DOMAIN (例如 tf27tjx68.hn-bkt.clouddn.com)",
        "  QINIU_BUCKET",
        "  QINIU_ACCESS_KEY",
        "  QINIU_SECRET_KEY",
        "  QINIU_UPLOAD_ENDPOINT (默认 http://upload.qiniup.com)",
        "  QINIU_PUBLIC_SCHEME (默认 http)",
        "  QINIU_PRIVATE_BUCKET (1 表示私有桶，会生成带 token 的下载链接)",
        "  QINIU_PRIVATE_URL_EXPIRES_SEC (默认 3600)",
        "",
        "说明：",
        "  - 当前测试发现你的七牛域名 https 证书不匹配，建议先用 http 的公网链接。",
        "  - 单图音频驱动接口只接受公网URL入参，所以本地文件需要先上传到对象存储。",
      ].join("\n")
    );
    return;
  }

  const accessKeyId = args["access-key-id"] || process.env.VOLC_VISUAL_ACCESS_KEY_ID;
  const secretAccessKey = args["secret-access-key"] || process.env.VOLC_VISUAL_SECRET_ACCESS_KEY;
  const token = args.token || process.env.VOLC_OPEN_SPEECH_TOKEN;
  const appid = args.appid || process.env.VOLC_OPEN_SPEECH_APPID;
  const speakerId = args["speaker-id"] || process.env.VOLC_OPEN_SPEECH_SPEAKER_ID;
  const flowConfigs = getFlowConfigs(args.flow || process.env.VOLC_AVATAR_FLOW || "85621");

  const imageUrlArg = args["image-url"] || process.env.VOLC_AVATAR_IMAGE_URL;
  const imageFile = args["image-file"] || process.env.VOLC_AVATAR_IMAGE_FILE;
  const audioUrlArg = args["audio-url"] || process.env.VOLC_AVATAR_AUDIO_URL;
  const audioFile = args["audio-file"] || process.env.VOLC_AVATAR_AUDIO_FILE;
  const ttsText = args["tts-text"] || process.env.VOLC_TTS_TEXT;

  requireValue("VOLC_VISUAL_ACCESS_KEY_ID / --access-key-id", accessKeyId);
  requireValue("VOLC_VISUAL_SECRET_ACCESS_KEY / --secret-access-key", secretAccessKey);
  if (!args["query-task-id"]) {
    requireValue("VOLC_OPEN_SPEECH_APPID / --appid", appid);
    requireValue("VOLC_OPEN_SPEECH_TOKEN / --token", token);
    requireValue("speaker-id", speakerId);
  }

  const outDir = args["out-dir"] || process.env.VOLC_OUTPUT_DIR || "tests/output";
  await fs.promises.mkdir(outDir, { recursive: true });

  if (args["query-task-id"]) {
    const queryReqKey = requireValue("--query-req-key", args["query-req-key"]);
    await queryExistingTask({
      accessKeyId,
      secretAccessKey,
      reqKey: queryReqKey,
      taskId: args["query-task-id"],
      outDir,
      outVideo: args["out-video"],
    });
    return;
  }

  const qiniuDomain = process.env.QINIU_DOMAIN;
  let qiniuBucket = process.env.QINIU_BUCKET;
  const qiniuAccessKey = process.env.QINIU_ACCESS_KEY;
  const qiniuSecretKey = process.env.QINIU_SECRET_KEY;
  const qiniuUploadEndpoint = process.env.QINIU_UPLOAD_ENDPOINT || "http://upload.qiniup.com";
  const qiniuPublicScheme = process.env.QINIU_PUBLIC_SCHEME || "http";
  const qiniuPrivateBucket = ["1", "true", "yes"].includes(String(process.env.QINIU_PRIVATE_BUCKET || "").toLowerCase());
  const qiniuPrivateUrlExpiresSec = Number(process.env.QINIU_PRIVATE_URL_EXPIRES_SEC || "3600");
  const qiniuKeyPrefix = (process.env.QINIU_KEY_PREFIX || "volc_demo/").replace(/^\/+/, "");

  if (qiniuDomain) {
    const check = await qiniuHeadPublicDomain({ domain: qiniuDomain, publicScheme: qiniuPublicScheme });
    if (check.ok) {
      console.log(`0) 七牛域名可连通：${check.url} status=${check.status}`);
    } else {
      console.log(`0) 七牛域名连通失败：${check.url} error=${check.error}`);
    }
  }

  if (!qiniuBucket && qiniuAccessKey && qiniuSecretKey) {
    try {
      const buckets = await qiniuListBuckets({ accessKey: qiniuAccessKey, secretKey: qiniuSecretKey });
      if (buckets.length > 0) {
        qiniuBucket = buckets[0];
        console.log(`0) 自动选择七牛 Bucket：${qiniuBucket}`);
      }
    } catch (e) {
      console.log(`0) 自动获取七牛 Bucket 失败：${String(e.message || e)}`);
    }
  }

  let imageUrl = imageUrlArg;
  if (!imageUrl && imageFile) {
    requireValue("QINIU_DOMAIN", qiniuDomain);
    requireValue("QINIU_ACCESS_KEY", qiniuAccessKey);
    requireValue("QINIU_SECRET_KEY", qiniuSecretKey);
    requireValue("QINIU_BUCKET(可留空自动获取；当前未获取到)", qiniuBucket);
    console.log("1) 上传图片到七牛...");
    const imageBuf = fs.readFileSync(imageFile);
    const imageExt = String(imageFile.split(".").pop() || "").toLowerCase() || "png";
    const imageKey = `${qiniuKeyPrefix}image_${sha1Hex(imageBuf)}.${imageExt}`;
    imageUrl = await qiniuUploadFileToPublicUrl({
      accessKey: qiniuAccessKey,
      secretKey: qiniuSecretKey,
      bucket: qiniuBucket,
      domain: qiniuDomain,
      publicScheme: qiniuPublicScheme,
      isPrivateBucket: qiniuPrivateBucket,
      privateUrlExpiresSec: qiniuPrivateUrlExpiresSec,
      uploadEndpoint: qiniuUploadEndpoint,
      keyPrefix: qiniuKeyPrefix,
      localPath: imageFile,
      fixedKey: imageKey,
      dataBuffer: imageBuf,
    });
    console.log(`   image_url=${imageUrl}`);
  }
  requireValue("image-url 或 image-file", imageUrl);

  let driveAudioUrl = audioUrlArg;
  let localAudioPath = null;

  if (!driveAudioUrl && audioFile) {
    requireValue("QINIU_DOMAIN", qiniuDomain);
    requireValue("QINIU_ACCESS_KEY", qiniuAccessKey);
    requireValue("QINIU_SECRET_KEY", qiniuSecretKey);
    requireValue("QINIU_BUCKET(可留空自动获取；当前未获取到)", qiniuBucket);
    console.log("2) 上传音频到七牛...");
    const audioBuf = fs.readFileSync(audioFile);
    const audioExt = String(audioFile.split(".").pop() || "").toLowerCase() || "mp3";
    const audioKey = `${qiniuKeyPrefix}audio_${sha1Hex(audioBuf)}.${audioExt}`;
    driveAudioUrl = await qiniuUploadFileToPublicUrl({
      accessKey: qiniuAccessKey,
      secretKey: qiniuSecretKey,
      bucket: qiniuBucket,
      domain: qiniuDomain,
      publicScheme: qiniuPublicScheme,
      isPrivateBucket: qiniuPrivateBucket,
      privateUrlExpiresSec: qiniuPrivateUrlExpiresSec,
      uploadEndpoint: qiniuUploadEndpoint,
      keyPrefix: qiniuKeyPrefix,
      localPath: audioFile,
      fixedKey: audioKey,
      dataBuffer: audioBuf,
    });
    console.log(`   audio_url=${driveAudioUrl}`);
  }

  if (!driveAudioUrl && ttsText) {
    requireValue("QINIU_DOMAIN", qiniuDomain);
    requireValue("QINIU_ACCESS_KEY", qiniuAccessKey);
    requireValue("QINIU_SECRET_KEY", qiniuSecretKey);
    requireValue("QINIU_BUCKET(可留空自动获取；当前未获取到)", qiniuBucket);

    const ttsResourceId = process.env.VOLC_OPEN_SPEECH_TTS_RESOURCE_ID || "seed-icl-2.0";
    const ttsFormat = process.env.VOLC_TTS_FORMAT || "mp3";
    const ttsSampleRate = Number(process.env.VOLC_TTS_SAMPLE_RATE || "24000");
    const ttsCacheKey = sha256Hex(`${ttsResourceId}|${speakerId}|${ttsFormat}|${ttsSampleRate}|${ttsText}`);

    const ttsExt = ttsFormat === "pcm" ? "pcm" : ttsFormat === "ogg_opus" ? "ogg" : "mp3";
    localAudioPath = `${outDir}/tts_${ttsCacheKey}.${ttsExt}`;

    let audioBuf = null;
    if (fs.existsSync(localAudioPath)) {
      console.log(`2) TTS音频已存在，直接复用：${localAudioPath}`);
      audioBuf = fs.readFileSync(localAudioPath);
    } else {
      console.log("2) TTS(声音复刻音色)生成音频...");
      audioBuf = await openspeechTtsToBuffer({
        appid,
        accessToken: token,
        resourceId: ttsResourceId,
        speakerId,
        text: ttsText,
        format: ttsFormat,
        sampleRate: ttsSampleRate,
      });
      fs.writeFileSync(localAudioPath, audioBuf);
    }
    console.log(`   audio_file=${localAudioPath}`);

    console.log("   上传生成音频到七牛...");
    const ttsQiniuKey = `${qiniuKeyPrefix}tts_${ttsCacheKey}.${ttsExt}`;
    driveAudioUrl = await qiniuUploadFileToPublicUrl({
      accessKey: qiniuAccessKey,
      secretKey: qiniuSecretKey,
      bucket: qiniuBucket,
      domain: qiniuDomain,
      publicScheme: qiniuPublicScheme,
      isPrivateBucket: qiniuPrivateBucket,
      privateUrlExpiresSec: qiniuPrivateUrlExpiresSec,
      uploadEndpoint: qiniuUploadEndpoint,
      keyPrefix: qiniuKeyPrefix,
      localPath: localAudioPath,
      fixedKey: ttsQiniuKey,
      dataBuffer: audioBuf,
    });
    console.log(`   audio_url=${driveAudioUrl}`);
  }

  requireValue("audio-url 或 audio-file 或 tts-text", driveAudioUrl);

  if (args["qiniu-only"]) {
    console.log("3) 仅验证七牛上传结果：");
    console.log(`   image_url=${imageUrl}`);
    console.log(`   audio_url=${driveAudioUrl}`);
    const checks = await Promise.all([
      axios.head(imageUrl, { timeout: 20_000, validateStatus: () => true }),
      axios.head(driveAudioUrl, { timeout: 20_000, validateStatus: () => true }),
    ]);
    console.log(`   image_head_status=${checks[0].status}`);
    console.log(`   audio_head_status=${checks[1].status}`);
    return;
  }

  let finalUrl = null;
  let successFlowName = null;
  const errors = [];
  for (const cfg of flowConfigs) {
    try {
      const result = await runAvatarFlow({ cfg, accessKeyId, secretAccessKey, imageUrl, driveAudioUrl });
      finalUrl = result.videoUrl;
      successFlowName = cfg.name;
      console.log("5) 结果：");
      if (finalUrl) {
        console.log(`   flow=${cfg.name}`);
        console.log(`   video_url=${finalUrl}`);
        break;
      }
      console.log(`   ${cfg.name} 未返回 video_url，原始响应：${JSON.stringify(result.videoResult)}`);
    } catch (e) {
      const message = String(e?.stack || e);
      errors.push({ flow: cfg.name, error: message });
      console.log(`   ${cfg.name} 失败：${message}`);
    }
  }

  if (!finalUrl) {
    throw new Error(`所有链路均失败：${JSON.stringify(errors, null, 2)}`);
  }

  if (finalUrl) {
    const flowTag = String(successFlowName || "avatar").replace(/[^\w-]+/g, "_");
    const outVideo = args["out-video"] || `${outDir}/avatar_${flowTag}_${randomId()}.mp4`;
    console.log(`6) 下载视频到本地：${outVideo}`);
    await downloadToFile(finalUrl, outVideo);
    console.log(`   saved=${outVideo}`);
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exitCode = 1;
});
