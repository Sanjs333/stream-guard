import http from "node:http";

export const info = {
  id: "stream-guard",
  name: "Stream Guard",
  description:
    "Captures complete AI streaming responses server-side for crash recovery",
};

let origEmit = null;
const activeStreams = new Map();
const backups = new Map();
const MAX_AGE = 30 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 1000;
const STREAM_IDLE_TIMEOUT = 3 * 60 * 1000;
const STREAM_MAX_DURATION = 30 * 60 * 1000;
let cleanupTimer = null;

export async function init(router) {
  origEmit = http.Server.prototype.emit;

  http.Server.prototype.emit = function (event) {
    if (event === "request") {
      const req = arguments[1];
      const res = arguments[2];
      if (req && res && req.method === "POST") {
        instrumentResponse(req, res);
      }
    }
    return origEmit.apply(this, arguments);
  };

  router.get("/backup", (req, res) => {
    const userId = getUserId(req);
    const backup = backups.get(userId);
    if (backup) {
      res.json(backup);
      return;
    }
    for (const [, stream] of activeStreams) {
      if (stream.userId === userId && stream.chunks.length > 0) {
        const rawData = stream.chunks.join("");
        const text = extractTextFromSSE(rawData);
        if (text && text.trim().length > 0) {
          res.json({
            text,
            textLength: text.length,
            timestamp: Date.now(),
            partial: true,
          });
          return;
        }
      }
    }
    res.json({ empty: true });
  });

  router.get("/clear", (req, res) => {
    const userId = getUserId(req);
    backups.delete(userId);
    res.json({ success: true });
  });

  router.get("/debug", (req, res) => {
    const userId = getUserId(req);
    const backup = backups.get(userId);
    res.json({
      serverPluginActive: true,
      activeStreams: activeStreams.size,
      backupCount: backups.size,
      currentUserBackup: backup
        ? {
            textLength: backup.textLength,
            timestamp: backup.timestamp,
            age: Math.round((Date.now() - backup.timestamp) / 1000) + "s",
            preview: backup.text.substring(0, 200),
          }
        : null,
    });
  });

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of backups) {
      if (now - v.timestamp > MAX_AGE) backups.delete(k);
    }
    for (const [k, v] of activeStreams) {
      const totalMinutes = Math.round((now - v.startTime) / 60000);
      const idleSeconds = Math.round(
        (now - (v.lastChunkTime || v.startTime)) / 1000,
      );
      const isIdle =
        now - (v.lastChunkTime || v.startTime) > STREAM_IDLE_TIMEOUT;
      const isTooLong = now - v.startTime > STREAM_MAX_DURATION;

      if (isIdle || isTooLong) {
        const rawData = v.chunks.join("");
        const text = extractTextFromSSE(rawData);
        if (isIdle) {
          console.warn(
            `[StreamGuard] ⚠️ 流已无响应 (${idleSeconds}秒未收到新数据，总耗时${totalMinutes}分钟)`,
          );
        } else {
          console.warn(
            `[StreamGuard] ⚠️ 流超出最大时长限制 (已运行${totalMinutes}分钟)`,
          );
        }
        if (text && text.trim().length > 0) {
          backups.set(v.userId, {
            text,
            textLength: text.length,
            timestamp: Date.now(),
          });
          console.warn(
            `[StreamGuard] 已从中断的流中保存 ${text.length}字 的备份，刷新页面后可恢复`,
          );
        } else {
          console.warn(`[StreamGuard] 中断的流中无可用文本内容`);
        }
        activeStreams.delete(k);
      }
    }
  }, CLEANUP_INTERVAL);

  console.log("[StreamGuard] 服务器插件已加载");
}

export async function exit() {
  if (origEmit) http.Server.prototype.emit = origEmit;
  if (cleanupTimer) clearInterval(cleanupTimer);
  activeStreams.clear();
  backups.clear();
  origEmit = null;
  console.log("[StreamGuard] 服务器插件已卸载");
}

function instrumentResponse(req, res) {
  const origWrite = res.write;
  const origEnd = res.end;
  const origWriteHead = res.writeHead;

  let isSSE = false;
  let streamId = null;
  let headerChecked = false;

  function markSSE() {
    if (isSSE) return;
    isSSE = true;
    streamId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeStreams.set(streamId, {
      userId: getUserId(req),
      chunks: [],
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      url: req.url,
    });
  }

  function checkHeader() {
    if (headerChecked) return;
    headerChecked = true;
    try {
      const ct = String(res.getHeader("content-type") || "");
      if (ct.includes("text/event-stream")) markSSE();
    } catch {}
  }

  function checkChunkForSSE(chunk) {
    if (isSSE) return;
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf-8", 0, Math.min(chunk.length, 300))
      : String(chunk).substring(0, 300);
    if (
      text.includes("data:") &&
      (text.includes('"choices"') ||
        text.includes('"delta"') ||
        text.includes('"content_block"') ||
        text.includes('"candidates"') ||
        text.includes("[DONE]"))
    ) {
      headerChecked = true;
      markSSE();
    }
  }

  function hasSSEContentType(args) {
    for (const arg of args) {
      if (arg && typeof arg === "object" && !Array.isArray(arg)) {
        for (const key of Object.keys(arg)) {
          if (
            key.toLowerCase() === "content-type" &&
            String(arg[key]).includes("text/event-stream")
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  res.writeHead = function () {
    const rest = Array.prototype.slice.call(arguments, 1);
    if (hasSSEContentType(rest)) {
      headerChecked = true;
      markSSE();
    }
    return origWriteHead.apply(this, arguments);
  };

  res.write = function (chunk, encoding, callback) {
    if (!headerChecked) checkHeader();
    if (!isSSE) checkChunkForSSE(chunk);
    if (isSSE && streamId) {
      const stream = activeStreams.get(streamId);
      if (stream) {
        stream.chunks.push(
          Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk),
        );
        stream.lastChunkTime = Date.now();
      }
    }
    return origWrite.call(this, chunk, encoding, callback);
  };

  res.end = function (chunk, encoding, callback) {
    if (!headerChecked) checkHeader();
    if (!isSSE && chunk) checkChunkForSSE(chunk);
    if (isSSE && streamId && activeStreams.has(streamId)) {
      const stream = activeStreams.get(streamId);
      activeStreams.delete(streamId);
      if (chunk) {
        stream.chunks.push(
          Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk),
        );
      }
      const rawData = stream.chunks.join("");
      const text = extractTextFromSSE(rawData);
      if (text && text.trim().length > 0) {
        backups.set(stream.userId, {
          text,
          textLength: text.length,
          timestamp: Date.now(),
        });
        console.log(`[StreamGuard] 备份已保存 (${text.length}字)，可刷新前端`);
      } else {
        const preview = rawData.substring(0, 300).replace(/\n/g, "\\n");
        console.warn(`[StreamGuard] ⚠️ 捕获到SSE流但无法提取文本内容`);
        console.warn(`[StreamGuard] URL: ${stream.url}`);
        console.warn(
          `[StreamGuard] 原始数据长度: ${rawData.length}字节, 块数: ${stream.chunks.length}`,
        );
        console.warn(`[StreamGuard] 数据预览(前300字符): ${preview}`);
        console.warn(
          `[StreamGuard] 如需适配此格式，请将以上信息反馈给插件开发者`,
        );
      }
    }
    return origEnd.call(this, chunk, encoding, callback);
  };
}

function getUserId(req) {
  return req?.user?.profile?.handle || req?.user?.handle || "default-user";
}

function extractTextFromSSE(rawData) {
  let fullText = "";
  let skipNext = false;
  for (const line of rawData.split("\n")) {
    if (line.startsWith("event:")) {
      skipNext = line.slice(6).trim() === "error";
      continue;
    }
    if (skipNext || !line.startsWith("data:")) {
      if (!line.startsWith("data:")) skipNext = false;
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      const token = extractToken(json);
      if (typeof token === "string") fullText += token;
    } catch (e) {
      console.warn(
        `[StreamGuard] ⚠️ SSE行解析失败: ${e.message} | 数据片段: ${data.substring(0, 100)}`,
      );
    }
  }
  return fullText;
}

function extractToken(json) {
  if (json.choices?.[0]?.delta?.content != null)
    return json.choices[0].delta.content;
  if (json.choices?.[0]?.text != null) return json.choices[0].text;
  if (json.choices?.[0]?.delta?.reasoning_content != null) return null;
  if (json.choices?.[0]?.delta?.reasoning != null) return null;
  if (json.choices?.[0]?.message?.content != null)
    return json.choices[0].message.content;
  if (json.type === "content_block_delta" && json.delta?.text != null)
    return json.delta.text;
  if (json.type === "content_block_delta" && json.delta?.thinking != null)
    return null;
  if (json.delta?.text != null) return json.delta.text;
  if (typeof json.token === "string") return json.token;
  if (typeof json.text === "string" && json.object !== "chat.completion.chunk")
    return json.text;
  if (Array.isArray(json.candidates)) {
    const parts = json.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      let combined = "";
      for (const part of parts) {
        if (typeof part.text === "string" && !part.thought)
          combined += part.text;
      }
      if (combined) return combined;
    }
  }
  return null;
}
