// FluxDown 插件：HuggingFace 加速（classic script，入口挂 globalThis）。
//
// 原理：命中 huggingface.co 的 /resolve/ 文件直链时，把 host 改写到公共镜像
// hf-mirror.com（path 与 query 原样保留，覆盖 models / datasets / spaces）。
// 改写前对「本次要下载的这个文件」在所有适用镜像上并行实测（GET +
// Range: bytes=0-65535，64 KB 采样），一次探测同时验证可用性与链路：
//   - 状态 200/206 视为可用；全部失败 → 返回 null 放行 HF 直连——镜像不可用
//     绝不阻断下载（resolve 返回 null 即放行，不触发 fail-closed）。
//   - 206 说明该镜像链路支持 Range，回填 rangeSupported 让引擎直接按多线程
//     分段规划。
//   - 镜像对大文件（Xet/LFS）返回 302 跳 cas-bridge.xethub.hf.co（签名链接，
//     约 1 小时有效）；对小文件 307 跳镜像自身 resolve-cache（相对路径），
//     datasets 路径实测是连续两跳。flux.fetch 是否自动跟随重定向未在文档中
//     约定，这里统一手动跟随（最多 3 跳）；若宿主已自动跟随，首轮即拿到最终
//     响应，两种行为都兼容。
//   - 同一 URL 的历史选择会被记住（flux.storage 内 LRU）：上次选中的镜像本次
//     探测仍可用就继续沿用，避免断点续传恢复时换源导致 ETag 校验不一致而
//     整段重下。
//
// 安全边界：
//   - 任务自带 Cookie 或 Authorization 头时直接放行直连，绝不把用户凭据发往
//     第三方镜像（gated 仓库请配置 Access Token 后使用普通直链）。
//   - Gated Repo：镜像返回 401/403 且用户配置了 Access Token 时，才带
//     Authorization: Bearer 重试一次——公开仓库的探测与下载全程不携带 token。
//     探测到 text/html（镜像把 gated 跳到登录页的情形）同样触发 token 重试，
//     且永不视为可用，防止把登录页当文件存盘。
//     token 只在同源跳转里保留：一旦重定向到别的 host（如 xethub CDN，签名
//     URL 本身自带鉴权）就丢弃 Authorization，避免凭据跟着跳转外泄。
//
// 注意 QuickJS 运行时没有 URL/定时器等浏览器全局，URL 处理用正则手写。
'use strict';
var PROBE_RANGE = 'bytes=0-65535'; // 64 KB 采样：够摊平 TLS/首包抖动，又不拖慢解析
var PICKS_KEY = 'picks:v1'; // storage：URL → 镜像 的记忆（LRU）
var PICKS_CAP = 24;
var PICKS_TTL_MS = 12 * 60 * 60 * 1000;
var HF_HOST_RE = /^https?:\/\/(www\.)?huggingface\.co\//i;
var MIRROR_ORIGIN = 'https://hf-mirror.com';
// —— 镜像注册表 ——
// 内置 hf-mirror（host 替换式改写）；用户可在设置里按行追加「前缀拼接式」镜像。
var BUILTIN_PROVIDERS = [
  {
    id: 'hfmirror',
    label: 'hf-mirror.com',
    rewrite: function (original) {
      return MIRROR_ORIGIN + original.replace(HF_HOST_RE, '/');
    },
  },
];
// —— HF 文件直链判断 ——
// 仅处理 /resolve/ 直链（model：/<owner>/<repo>/resolve/...；datasets / spaces：
// /<type>/<owner>/<repo>/resolve/...，即 resolve 前至少 2 段且其后还有路径）。
// 仓库主页、讨论区等非文件链接一律放行，不做改写。
function isHfFileUrl(url) {
  if (!HF_HOST_RE.test(url || '')) return false;
  var path = url.replace(HF_HOST_RE, '/');
  var clean = path.split('?')[0].split('#')[0];
  var segs = [];
  var parts = clean.split('/');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) segs.push(parts[i]);
  }
  // 取最后一个 resolve：owner / repo 恰好叫 resolve 时不能误判。
  var idx = segs.lastIndexOf('resolve');
  // resolve 之后必须还有 ref 与文件路径至少 2 段（/resolve/main 这种目录形放行）。
  return idx >= 2 && idx <= segs.length - 3;
}
// —— 用户自定义镜像前缀（设置项 extraMirrors，每行一个 https:// 前缀）——
function extraProviders() {
  var raw = String(flux.settings.extraMirrors || '');
  var out = [];
  var seen = {};
  var lines = raw.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].trim();
    if (!s) continue;
    if (!/^https:\/\/[^\/\s]+/i.test(s)) continue; // 仅 https，与宿主 fetch 护栏一致
    if (s.charAt(s.length - 1) !== '/') s += '/';
    if (seen[s]) continue;
    seen[s] = true;
    var hm = /^https:\/\/([^\/]+)/i.exec(s);
    var host = hm ? hm[1].toLowerCase() : 'mirror' + i;
    out.push({
      id: 'extra:' + host,
      label: host,
      rewrite: (function (prefix) {
        return function (original) {
          return prefix + original;
        };
      })(s),
    });
  }
  return out;
}
// —— 响应头读取（大小写不敏感）——
function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers[name] === 'string') return headers[name];
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (k.toLowerCase() === lower && typeof headers[k] === 'string') return headers[k];
  }
  return '';
}
// 相对 Location 拼接：hf-mirror 的 307 Location 为站内相对路径。
function absUrl(current, loc) {
  if (/^https?:\/\//i.test(loc)) return loc;
  var m = /^(https?:\/\/[^\/]+)/i.exec(current);
  var origin = m ? m[1] : '';
  if (loc.charAt(0) === '/') return origin + loc;
  return origin + '/' + loc;
}
function originOf(url) {
  var m = /^(https?:\/\/[^\/]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}
// 路径本身是 html 文件时不做「登录页」判定，避免把仓库里的 .html 资源误杀。
function isHtmlFile(url) {
  return /\.html?$/i.test((url || '').split('?')[0].split('#')[0]);
}
// —— 探测：一次 Range 采样同时得到 可用性 / 耗时 / Range 支持 ——
// 3xx 手动跟随重定向（≤3 跳）；宿主若自动跟随，首轮即得最终响应。
// token 可选：仅在 gated 重试时传入。200 但 Content-Type 为 text/html 视为
// 不可用（gated 被跳到登录页），防止把登录页当文件。
function probe(p, url, token) {
  var t0 = Date.now();
  var current = url;
  var headers = { range: PROBE_RANGE };
  if (token) headers.authorization = 'Bearer ' + token;
  function attempt(hop, hdrs) {
    return flux.fetch({ url: current, headers: hdrs }).then(
      function (res) {
        if (res.status >= 300 && res.status < 400 && hop < 3) {
          var loc = headerValue(res.headers, 'location');
          if (loc) {
            var next = absUrl(current, loc);
            // 跨 host 跳转丢弃凭据：签名 CDN 自带鉴权，不需要也不应收到 token。
            var nextHeaders = hdrs;
            if (originOf(next) !== originOf(current)) {
              nextHeaders = {};
              for (var hk in hdrs) {
                if (hk.toLowerCase() !== 'authorization') nextHeaders[hk] = hdrs[hk];
              }
            }
            current = next;
            return attempt(hop + 1, nextHeaders);
          }
        }
        var ct = headerValue(res.headers, 'content-type').toLowerCase();
        var html = ct.indexOf('text/html') !== -1 && !isHtmlFile(current);
        var ok = (res.status === 200 || res.status === 206) && !html;
        return {
          p: p,
          url: url,
          ok: ok,
          ms: Date.now() - t0,
          status: res.status,
          html: html,
          ranged: res.status === 206,
          error: ok ? '' : 'HTTP ' + res.status + (html ? '（text/html，疑似登录页）' : ''),
        };
      },
      function (err) {
        return {
          p: p,
          url: url,
          ok: false,
          ms: Date.now() - t0,
          status: 0,
          html: false,
          ranged: false,
          error: String((err && err.message) || err),
        };
      },
    );
  }
  return attempt(0, headers);
}
// —— URL → 镜像 的历史选择（续传稳定性）——
function loadPicks() {
  return flux.storage.get(PICKS_KEY).then(
    function (v) {
      if (!v) return {};
      try {
        var obj = JSON.parse(v);
        return obj && typeof obj === 'object' ? obj : {};
      } catch (e) {
        return {};
      }
    },
    function () {
      return {};
    },
  );
}
function savePick(picks, url, id) {
  var now = Date.now();
  picks[url] = { id: id, at: now };
  var keys = [];
  for (var k in picks) {
    var e = picks[k];
    if (!e || typeof e.at !== 'number' || now - e.at > PICKS_TTL_MS) {
      delete picks[k];
    } else {
      keys.push(k);
    }
  }
  if (keys.length > PICKS_CAP) {
    keys.sort(function (a, b) {
      return picks[a].at - picks[b].at;
    });
    for (var i = 0; i < keys.length - PICKS_CAP; i++) delete picks[keys[i]];
  }
  return flux.storage.set(PICKS_KEY, JSON.stringify(picks)).then(
    function () {},
    function () {}, // 存储失败不影响本次解析
  );
}
function findById(results, id) {
  for (var i = 0; i < results.length; i++) {
    if (results[i].p.id === id) return results[i];
  }
  return null;
}
function fastest(results) {
  var best = results[0];
  for (var i = 1; i < results.length; i++) {
    if (results[i].ms < best.ms) best = results[i];
  }
  return best;
}
globalThis.resolve = async function (ctx) {
  try {
    var mode = String(flux.settings.mode || 'auto');
    if (mode === 'direct') return null;
    if (!isHfFileUrl(ctx.url)) return null; // 非文件直链（仓库页 / 讨论区 …）→ 放行
    // 凭据保护：任务自带 Cookie / Authorization 时绝不发往第三方镜像。
    // 镜像的 gated 方案是 Access Token（Authorization: Bearer），会话 Cookie
    // 无法通过镜像使用，改写这类任务没有收益只有泄漏风险 → 一律放行。
    var hasAuth =
      !!(ctx.cookies && String(ctx.cookies).trim()) ||
      !!(ctx.extraHeaders &&
        (headerValue(ctx.extraHeaders, 'authorization') || headerValue(ctx.extraHeaders, 'cookie')));
    if (hasAuth) {
      flux.logger.info('[hf-accel] 任务携带凭据，放行直连（Gated Repo 请配置 Access Token 后用普通直链）: ' + ctx.url);
      return null;
    }
    // token 容错：去掉粘贴时带入的空白，以及误加的 "Bearer " 前缀。
    var hfToken = String(flux.settings.hfToken || '')
      .replace(/\s+/g, '')
      .replace(/^Bearer/i, '');
    var providers = BUILTIN_PROVIDERS.concat(extraProviders());
    var candidates = [];
    for (var i = 0; i < providers.length; i++) {
      candidates.push({ p: providers[i], url: providers[i].rewrite(ctx.url) });
    }
    // 第一轮：无 token 探测——公开仓库到此为止，token 全程不出网。
    var results = await Promise.all(
      candidates.map(function (c) {
        return probe(c.p, c.url);
      }),
    );
    var ok = results.filter(function (r) {
      return r.ok;
    });
    if (flux.settings.verbose) {
      for (var k = 0; k < results.length; k++) {
        var r = results[k];
        flux.logger.info(
          '[hf-accel] 探测 ' + r.p.label + ': ' +
            (r.ok ? 'HTTP ' + r.status + ' ' + r.ms + 'ms' : '失败 ' + (r.error || 'HTTP ' + r.status)),
        );
      }
    }
    // 第二轮：全部 401/403（或被跳登录页）且配置了 token → 带 token 重试一次。
    var usedToken = false;
    if (!ok.length && hfToken) {
      var gated = results.filter(function (r) {
        return r.status === 401 || r.status === 403 || r.html;
      });
      if (gated.length) {
        if (flux.settings.verbose) {
          flux.logger.info('[hf-accel] 镜像返回 401/403，携带 Access Token 重试');
        }
        var retry = await Promise.all(
          gated.map(function (r) {
            return probe(r.p, r.url, hfToken);
          }),
        );
        if (flux.settings.verbose) {
          for (var j = 0; j < retry.length; j++) {
            var t = retry[j];
            flux.logger.info(
              '[hf-accel] token 重试 ' + t.p.label + ': ' +
                (t.ok ? 'HTTP ' + t.status + ' ' + t.ms + 'ms' : '失败 ' + (t.error || 'HTTP ' + t.status)),
            );
          }
        }
        ok = retry.filter(function (r) {
          return r.ok;
        });
        usedToken = ok.length > 0;
      }
    }
    if (!ok.length) {
      flux.logger.warn('[hf-accel] 所有镜像探测失败，放行 HF 直连: ' + ctx.url);
      return null;
    }
    // 优先级：固定镜像（可用时）> 同 URL 历史选择（可用时，保续传一致）> 实测最快
    var picks = await loadPicks();
    var best = null;
    if (mode === 'mirror') best = findById(ok, BUILTIN_PROVIDERS[0].id);
    if (!best && picks[ctx.url]) best = findById(ok, picks[ctx.url].id);
    if (!best) best = fastest(ok);
    await savePick(picks, ctx.url, best.p.id);
    flux.logger.info(
      '[hf-accel] 选用 ' + best.p.label + '（' + best.ms + 'ms, HTTP ' + best.status + '）加速 ' + ctx.url,
    );
    var out = { url: best.url };
    if (best.ranged) out.rangeSupported = true; // 206 已实证支持 Range，直接多线程分段
    if (usedToken) {
      // extraHeaders 会替换任务原有请求头表，这里把非凭据的头一并带上，避免丢 Referer 等。
      var merged = {};
      var src = ctx.extraHeaders || {};
      for (var key in src) {
        var lower = key.toLowerCase();
        if (lower === 'authorization' || lower === 'cookie') continue;
        if (typeof src[key] === 'string') merged[key] = src[key];
      }
      merged.authorization = 'Bearer ' + hfToken;
      out.extraHeaders = merged;
    }
    return out;
  } catch (e) {
    // 插件内部任何意外都不应阻断下载：记日志后放行直连。
    flux.logger.error('[hf-accel] 解析异常，放行直连: ' + String((e && e.message) || e));
    return null;
  }
};
