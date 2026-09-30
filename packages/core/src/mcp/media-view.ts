/**
 * The view Claude renders in a chat for Pepper's media tools (an "MCP App",
 * SEP-1865): the generated image, a video or audio player, or a progress bar
 * that follows a job until it has something to show.
 *
 * Without it a chat only ever gets a link: a host gives an image in a tool
 * result to the model, not to the person, and has no way at all to present
 * a video or a song.
 *
 * How it fits together:
 *
 * - Media tools name this resource in `_meta.ui.resourceUri`. A host that
 *   supports MCP Apps reads it once and renders it in a sandboxed iframe for
 *   each call; any other host ignores the key and nothing changes.
 * - The host hands the view the tool's result. `structuredContent.jobs` says
 *   what to draw (see `viewJob` in tools.ts). Images are drawn from the inline
 *   preview already in the result; video and audio are loaded from Pepper by a
 *   signed link (`signMediaUrl`), which is why the resource declares Pepper's
 *   origin in its CSP — the iframe can send neither a header nor our cookie.
 *   If the host blocks that load anyway, the view asks for the file through
 *   the host instead (`resources/read` of `pepper://outputs/<name>`) and plays
 *   it from a blob.
 * - For a job still queued or running, the view polls `get_job` through the
 *   host, so a video appears in place when it finishes.
 *
 * One self-contained document with no dependencies: the protocol is a few
 * JSON-RPC messages over postMessage, which costs less here than bundling the
 * ext-apps SDK into a server that has no bundler. The script is kept free of
 * backticks and dollar-brace so it can live in this template literal.
 */

export const MEDIA_VIEW_URI = 'ui://pepper/media.html';
export const MEDIA_VIEW_MIME = 'text/html;profile=mcp-app';

/** Resource metadata: which origin the view may load media from. */
export function mediaViewMeta(baseUrl: string): { ui: Record<string, unknown> } {
  return {
    ui: {
      csp: { resourceDomains: [baseUrl] },
      // The view draws its own frame around each result.
      prefersBorder: false,
    },
  };
}

export const MEDIA_VIEW_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Pepper</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-secondary, light-dark(#f5f4f0, #262624));
    --fg: var(--color-text-primary, light-dark(#1f1e1d, #f3f2ee));
    --muted: var(--color-text-secondary, light-dark(#6b6a66, #a5a39c));
    --line: var(--color-border-secondary, light-dark(#dddbd3, #3d3c39));
    --danger: var(--color-text-danger, light-dark(#b3261e, #f2857d));
    --accent: var(--color-text-info, light-dark(#c2410c, #f0a070));
    --radius: var(--border-radius-lg, 12px);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--font-text-sm-size, 13px);
    line-height: 1.45;
    color: var(--fg);
  }
  #root { display: grid; gap: 10px; padding: 2px; }
  #root.many { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    overflow: hidden;
    min-width: 0;
  }
  .media { display: block; width: 100%; background: #000; }
  img.media { height: auto; max-height: var(--media-max, 640px); object-fit: contain; cursor: zoom-in; }
  video.media { max-height: var(--media-max, 640px); }
  .audio { padding: 14px 12px 4px; }
  .audio audio { display: block; width: 100%; }
  .caption { padding: 10px 12px 0; color: var(--fg); overflow-wrap: anywhere; }
  .caption.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .foot { display: flex; align-items: center; gap: 10px; padding: 8px 12px; color: var(--muted); }
  .foot .meta { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button {
    font: inherit; color: var(--fg); cursor: pointer;
    background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 3px 10px;
  }
  button:hover { border-color: var(--muted); }
  .status { padding: 12px; }
  .status .label { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); }
  .status .label b { color: var(--fg); font-weight: 600; }
  .bar { height: 4px; margin-top: 8px; border-radius: 2px; background: var(--line); overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .4s ease; }
  .bar.wait i { width: 35%; animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .bar.wait i { animation: none; width: 100%; opacity: .4; } }
  .error { padding: 12px; color: var(--danger); overflow-wrap: anywhere; }
  .note { padding: 0 12px 10px; color: var(--muted); }
  .empty { color: var(--muted); padding: 4px 2px; }
</style>
</head>
<body>
<div id="root"><div class="empty">Waiting for Pepper…</div></div>
<script>
(function () {
  'use strict';
  var PROTOCOL = '2026-01-26';
  var DONE = { completed: 1, failed: 1, cancelled: 1 };
  var root = document.getElementById('root');

  var nextId = 1;
  var pending = {};
  var host = { capabilities: {}, context: {} };
  var state = { order: [], jobs: {}, previews: {}, broken: {}, polling: {}, stalled: {}, prompt: '', closed: false,
    blobs: {}, fetching: {}, fetched: {} };

  // --- JSON-RPC over postMessage -------------------------------------------

  function post(message) { window.parent.postMessage(message, '*'); }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method) return receive(message);
    var waiter = pending[message.id];
    if (!waiter) return;
    delete pending[message.id];
    if (message.error) waiter.reject(new Error(message.error.message || 'request failed'));
    else waiter.resolve(message.result || {});
  });

  function receive(message) {
    var params = message.params || {};
    var reply = function (result) { if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, result: result }); };
    switch (message.method) {
      case 'ui/notifications/tool-input':
        // Only the call that opened this view carries a prompt; the view's own
        // get_job calls must not replace it.
        if (!state.prompt) state.prompt = String((params.arguments || {}).prompt || (params.arguments || {}).input || '');
        render();
        break;
      case 'ui/notifications/tool-result':
        ingest(params);
        break;
      case 'ui/notifications/tool-cancelled':
        if (!state.order.length) show('empty', 'Cancelled.');
        break;
      case 'ui/notifications/host-context-changed':
        applyContext(params);
        break;
      case 'ui/resource-teardown':
        state.closed = true;
        Array.prototype.forEach.call(document.querySelectorAll('video, audio'), function (el) { el.pause(); });
        reply({});
        break;
      case 'ping':
        reply({});
        break;
      default:
        if (message.id !== undefined) {
          post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        }
    }
  }

  // --- Host context ----------------------------------------------------------

  function applyContext(context) {
    if (!context) return;
    for (var key in context) host.context[key] = context[key];
    var style = document.documentElement.style;
    if (context.theme === 'light' || context.theme === 'dark') style.colorScheme = context.theme;
    var variables = context.styles && context.styles.variables;
    if (variables) for (var name in variables) if (variables[name]) style.setProperty(name, variables[name]);
    var box = context.containerDimensions;
    if (box) {
      var limit = box.height || box.maxHeight;
      // Leave room for the caption and footer under the picture.
      if (limit) style.setProperty('--media-max', Math.max(160, limit - 90) + 'px');
    }
  }

  // --- Results ---------------------------------------------------------------

  /** Take a tool result (pushed by the host, or returned to our own get_job). */
  function ingest(result) {
    if (!result) return;
    var content = result.content || [];
    var jobs = result.structuredContent && result.structuredContent.jobs;
    if (!Array.isArray(jobs)) jobs = jobsFromText(content);
    jobs.forEach(function (job) {
      if (!job || !job.id) return;
      if (!state.jobs[job.id]) state.order.push(job.id);
      state.jobs[job.id] = job;
      var block = typeof job.preview === 'number' ? content[job.preview] : null;
      if (block && block.type === 'image' && block.data) {
        state.previews[job.id] = 'data:' + (block.mimeType || 'image/jpeg') + ';base64,' + block.data;
      }
      if (!DONE[job.status]) follow(job.id);
    });
    if (!state.order.length && result.isError) return show('error', textOf(content) || 'The request failed.');
    render();
  }

  /** A server older than this view sends only JSON text blocks; read those. */
  function jobsFromText(content) {
    var jobs = [];
    content.forEach(function (block) {
      if (block.type !== 'text') return;
      try {
        var value = JSON.parse(block.text);
        (Array.isArray(value) ? value : [value]).forEach(function (job) {
          if (job && job.id && job.status) jobs.push(job);
        });
      } catch (e) { /* not a job summary */ }
    });
    return jobs;
  }

  function textOf(content) {
    return content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
  }

  /** Poll a running job through the host until it settles. */
  function follow(id) {
    if (state.polling[id] || state.closed) return;
    if (!host.capabilities.serverTools) return;
    state.polling[id] = true;
    var failures = 0;
    (function again() {
      if (state.closed) return;
      request('tools/call', { name: 'get_job', arguments: { id: id, wait_seconds: 25 } }).then(function (result) {
        failures = 0;
        // Still marked as polling, so ingest does not start a second loop.
        ingest(result);
        var job = state.jobs[id];
        if (job && !DONE[job.status] && !result.isError) setTimeout(again, 1000);
        else state.polling[id] = false;
      }, function () {
        // The host may refuse app-initiated calls, or the instance may be gone.
        if (++failures < 4) return setTimeout(again, 5000 * failures);
        state.polling[id] = false;
        state.stalled[id] = true;
        render();
      });
    })();
  }

  /**
   * The direct link did not load (blocked by the host's sandbox, or expired):
   * fetch the file through the host once, and play it from memory.
   */
  function recover(job) {
    var id = job.id;
    if (state.fetched[id] || !job.output_name || !host.capabilities.serverResources) {
      state.broken[id] = true;
      return render();
    }
    state.fetched[id] = true;
    state.fetching[id] = true;
    render();
    request('resources/read', { uri: 'pepper://outputs/' + encodeURIComponent(job.output_name) }).then(function (result) {
      var item = (result.contents || [])[0] || {};
      if (!item.blob) throw new Error('no data');
      var binary = atob(item.blob);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      state.blobs[id] = URL.createObjectURL(new Blob([bytes], { type: item.mimeType || '' }));
    }).catch(function () {
      state.broken[id] = true;
    }).then(function () {
      state.fetching[id] = false;
      render();
    });
  }

  // --- Drawing ---------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function show(className, text) {
    root.className = '';
    root.replaceChildren(el('div', className, text));
    resized();
  }

  function mediaKind(job) {
    if (job.media) return job.media;
    var name = String(job.output_name || job.url || '').split('?')[0].toLowerCase();
    if (/\.(png|jpe?g|webp|gif)$/.test(name)) return 'image';
    if (/\.(webm|mp4|mov|mkv)$/.test(name)) return 'video';
    if (/\.(wav|mp3|flac|ogg|opus|m4a)$/.test(name)) return 'audio';
    return '';
  }

  function openLink(url) {
    if (!url) return;
    if (host.capabilities.openLinks) request('ui/open-link', { url: url }).catch(function () {});
    else window.open(url, '_blank', 'noopener');
  }

  function seconds(ms) {
    var s = Math.round(ms / 1000);
    return s < 90 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }

  function card(job) {
    var node = el('div', 'card');
    node.dataset.job = job.id;
    var kind = mediaKind(job);
    var link = job.media_url || job.url;
    var source = state.blobs[job.id] || link;

    if (job.status === 'completed' && (kind || state.previews[job.id])) {
      if (state.fetching[job.id]) {
        node.appendChild(el('div', 'note', 'Loading the preview…')).style.paddingTop = '12px';
      } else if (state.broken[job.id]) {
        node.appendChild(el('div', 'note', 'The preview could not be loaded here. Open it instead.')).style.paddingTop = '12px';
      } else if (kind === 'video') {
        var video = el('video', 'media');
        video.controls = true; video.playsInline = true; video.preload = 'metadata';
        video.src = source;
        video.addEventListener('error', function () { recover(job); });
        video.addEventListener('loadedmetadata', resized);
        node.appendChild(video);
      } else if (kind === 'audio') {
        var wrap = el('div', 'audio');
        var audio = el('audio');
        audio.controls = true; audio.preload = 'metadata';
        audio.src = source;
        audio.addEventListener('error', function () { recover(job); });
        wrap.appendChild(audio);
        node.appendChild(wrap);
      } else {
        var image = el('img', 'media');
        image.alt = state.prompt || 'Generated image';
        image.src = state.previews[job.id] || source;
        image.addEventListener('load', resized);
        image.addEventListener('error', function () { recover(job); });
        image.addEventListener('click', function () { openLink(link); });
        node.appendChild(image);
      }
      if (state.prompt && kind === 'audio') node.appendChild(el('div', 'caption clamp', state.prompt));
      var foot = el('div', 'foot');
      var meta = [];
      if (job.seed !== undefined) meta.push('seed ' + job.seed);
      if (job.duration_ms) meta.push(seconds(job.duration_ms));
      if (job.output_name) meta.push(job.output_name);
      var label = el('span', 'meta', meta.join(' · '));
      label.title = meta.join(' · ');
      foot.appendChild(label);
      if (link) {
        var open = el('button', '', 'Open');
        open.type = 'button';
        open.addEventListener('click', function () { openLink(link); });
        foot.appendChild(open);
      }
      node.appendChild(foot);
      return node;
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      var reason = job.error && (job.error.message || job.error.code);
      node.appendChild(el('div', 'error', job.status === 'cancelled' ? 'Cancelled.' : 'Failed: ' + (reason || 'unknown error')));
      return node;
    }

    if (job.status === 'completed') {
      node.appendChild(el('div', 'status', 'Done.'));
      return node;
    }

    // Queued or running.
    var status = el('div', 'status');
    var line = el('div', 'label');
    var what = job.kind ? job.kind.charAt(0).toUpperCase() + job.kind.slice(1) : 'Job';
    line.appendChild(el('b', '', job.status === 'queued' ? what + ' queued' : 'Generating ' + what.toLowerCase() + '…'));
    var fraction = typeof job.progress === 'number' ? job.progress : 0;
    var detail = job.step && job.total_steps ? 'step ' + job.step + ' of ' + job.total_steps
      : fraction > 0 ? Math.round(fraction * 100) + '%' : '';
    line.appendChild(el('span', '', detail));
    status.appendChild(line);
    var bar = el('div', fraction > 0 ? 'bar' : 'bar wait');
    var fill = el('i');
    if (fraction > 0) fill.style.width = Math.min(100, Math.round(fraction * 100)) + '%';
    bar.appendChild(fill);
    status.appendChild(bar);
    node.appendChild(status);
    if (state.stalled[job.id] || !host.capabilities.serverTools) {
      node.appendChild(el('div', 'note', 'Ask Claude to check on job ' + job.id + ' to see the result.'));
    }
    return node;
  }

  /**
   * Redraw, reusing a playing video or audio element: progress updates for
   * one job must not restart the clip the person is watching in another.
   */
  function render() {
    if (!state.order.length) return;
    var keep = {};
    Array.prototype.forEach.call(root.children, function (child) {
      var id = child.dataset && child.dataset.job;
      if (id && child.dataset.signature === signature(state.jobs[id])) keep[id] = child;
    });
    var nodes = state.order.map(function (id) {
      if (keep[id]) return keep[id];
      var node = card(state.jobs[id]);
      node.dataset.signature = signature(state.jobs[id]);
      return node;
    });
    root.className = nodes.length > 1 ? 'many' : '';
    root.replaceChildren.apply(root, nodes);
    resized();
  }

  function signature(job) {
    return [job.status, job.progress, job.step, job.media_url || job.url, !!state.previews[job.id],
      !!state.broken[job.id], !!state.stalled[job.id], !!state.fetching[job.id], state.blobs[job.id] || '',
      state.prompt].join('|');
  }

  var lastSize = '';
  function resized() {
    requestAnimationFrame(function () {
      var width = Math.ceil(document.documentElement.scrollWidth);
      var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      var size = width + 'x' + height;
      if (size === lastSize) return;
      lastSize = size;
      notify('ui/notifications/size-changed', { width: width, height: height });
    });
  }
  if (window.ResizeObserver) new ResizeObserver(resized).observe(document.documentElement);

  // --- Handshake -------------------------------------------------------------

  request('ui/initialize', {
    appInfo: { name: 'pepper-media', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: PROTOCOL
  }).then(function (result) {
    host.capabilities = result.hostCapabilities || {};
    applyContext(result.hostContext);
    notify('ui/notifications/initialized');
    // A result can arrive before the handshake settles; start anything it left waiting.
    state.order.forEach(function (id) { if (!DONE[state.jobs[id].status]) follow(id); });
    render();
    resized();
  }, function () {
    notify('ui/notifications/initialized');
  });
})();
</script>
</body>
</html>
`;
