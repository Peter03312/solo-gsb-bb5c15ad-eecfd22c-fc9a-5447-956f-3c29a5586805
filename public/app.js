'use strict';

/* ================= 全局状态 ================= */
const state = {
  view: 'list',
  videos: [],
  video: null,
  segments: [],
  publications: [],
  activeSegmentId: null,
  editor: null, // { mode:'create'|'edit', segmentId, revision, initialText, dirty }
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const app = $('app');

/* ================= 工具 ================= */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}
function fmtTimeShort(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (h ? `${h}:` : '') + `${pad(m)}:${pad(s)}`;
}

async function api(url, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data && data.error;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function currentVideoEl() { return $('videoPlayer'); }
function currentMs() {
  const v = currentVideoEl();
  return v ? Math.floor(v.currentTime * 1000) : 0;
}

/* ================= 视图：视频列表 / 上传 ================= */
async function loadList() {
  const data = await api('/api/videos');
  state.videos = data.videos;
  state.view = 'list';
  stopPolling();
  render();
}

function renderList() {
  app.innerHTML = `
    <section class="card">
      <h2>上传新视频</h2>
      <div class="upload-row">
        <label>标题
          <input type="text" id="upTitle" placeholder="例如：产品发布会完整版" />
        </label>
        <label>视频文件（浏览器会读取时长并随上传提交）
          <input type="file" id="upFile" accept="video/*" />
        </label>
        <button class="btn primary" id="upBtn">上传</button>
      </div>
      <p id="uploadMsg"></p>
    </section>

    <section class="card">
      <h2>视频列表（${state.videos.length}）</h2>
      <div class="video-list" id="videoList"></div>
    </section>`;

  $('upFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('upTitle').value ||= file.name.replace(/\.[^.]+$/, '');
    $('uploadMsg').textContent = `已选择 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB），点击上传后由浏览器读取时长…`;
  });

  $('upBtn').addEventListener('click', uploadVideo);

  const list = $('videoList');
  if (!state.videos.length) {
    list.innerHTML = '<p class="meta">暂无视频，先上传一个吧。</p>';
    return;
  }
  list.innerHTML = state.videos.map((v) => {
    const allReviewed = v.segment_count > 0 && v.segment_count === v.reviewed_count;
    const reviewBadge = v.segment_count === 0
      ? '<span class="badge warn">无字幕</span>'
      : allReviewed
        ? '<span class="badge ok">全部已审</span>'
        : `<span class="badge warn">已审 ${v.reviewed_count}/${v.segment_count}</span>`;
    return `
      <div class="video-item" data-id="${v.id}">
        <div class="name">${esc(v.title)}</div>
        <div class="stats">
          <span>时长 ${fmtTime(v.duration_ms)}</span>
          <span>${v.segment_count} 段</span>
          ${reviewBadge}
          ${v.latest_version ? `<span class="badge ok">已发布 v${v.latest_version}</span>` : ''}
        </div>
        <div class="meta" style="margin-top:6px">${esc(v.original_name)}</div>
      </div>`;
  }).join('');
  list.querySelectorAll('.video-item').forEach((el) =>
    el.addEventListener('click', () => openVideo(Number(el.dataset.id)))
  );
}

function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = url;
    probe.addEventListener('loadedmetadata', () => {
      const ms = Math.round(probe.duration * 1000);
      URL.revokeObjectURL(url);
      if (!Number.isFinite(ms) || ms <= 0) reject(new Error('无法读取该视频的时长，请换用 MP4/WebM 等浏览器可识别的格式'));
      else resolve(ms);
    });
    probe.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      reject(new Error('浏览器无法解析该视频文件，请换用 MP4/WebM 格式'));
    });
  });
}

async function uploadVideo() {
  const title = $('upTitle').value.trim();
  const file = $('upFile').files[0];
  const msg = $('uploadMsg');
  if (!title) { msg.textContent = '请先填写标题'; return; }
  if (!file) { msg.textContent = '请选择视频文件'; return; }
  msg.textContent = '正在读取视频时长…';
  let durationMs;
  try {
    durationMs = await readVideoDuration(file);
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  msg.textContent = `时长 ${fmtTime(durationMs)}，正在上传…`;
  const fd = new FormData();
  fd.append('title', title);
  fd.append('duration_ms', String(durationMs));
  fd.append('video', file);
  try {
    await api('/api/videos', { method: 'POST', body: fd });
    toast('上传成功');
    await loadList();
  } catch (e) {
    msg.textContent = `上传失败：${e.message}`;
  }
}

/* ================= 视图：校对工作台 ================= */
async function openVideo(id) {
  const data = await api(`/api/videos/${id}`);
  state.view = 'detail';
  state.video = data.video;
  state.segments = data.segments;
  state.publications = data.publications;
  state.activeSegmentId = null;
  render();
  startPolling();
}

function backToList() { stopPolling(); loadList(); }

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollRefresh, 5000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}
function anyModalOpen() {
  return !$('editorModal').classList.contains('hidden') ||
         !$('conflictModal').classList.contains('hidden') ||
         !$('importModal').classList.contains('hidden') ||
         !$('restoreModal').classList.contains('hidden');
}
async function pollRefresh() {
  if (anyModalOpen() || !state.video) return;
  if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  try {
    const data = await api(`/api/videos/${state.video.id}`);
    const changed = JSON.stringify(data.segments.map(stripSeg)) !== JSON.stringify(state.segments.map(stripSeg));
    state.segments = data.segments;
    state.publications = data.publications;
    if (changed) {
      renderSegmentDependent();
      toast('检测到他人的修改，已刷新片段列表');
    }
  } catch (_) { /* 忽略轮询错误 */ }
}
function stripSeg(s) {
  return [s.id, s.start_ms, s.end_ms, s.text, s.reviewed, s.revision];
}

function render() {
  if (state.view === 'list') { renderList(); return; }
  renderDetail();
}

function renderDetail() {
  const v = state.video;
  const allReviewed = state.segments.length > 0 && state.segments.every((s) => s.reviewed);
  app.innerHTML = `
    <span class="back-link" id="backLink">← 返回视频列表</span>

    <div class="workbench-grid">
      <div>
        <section class="card">
          <h2>${esc(v.title)} <span class="meta">时长 ${fmtTime(v.duration_ms)} ｜ 共 ${state.segments.length} 段
            ${allReviewed ? '｜<span style="color:var(--ok)">全部已审</span>' : ''}</span></h2>
          <video id="videoPlayer" controls preload="metadata" src="/api/videos/${v.id}/media"></video>
          <div class="subtitle-overlay" id="subtitleOverlay">— 播放时此处显示当前字幕 —</div>
          <div id="timelineContainer"></div>
        </section>

        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2 style="margin:0">片段列表</h2>
            <div class="row-actions">
              <button class="btn small" id="restoreRangeBtn">↩ 区间恢复…</button>
              <button class="btn small" id="importSrtBtn">⬆ 导入 SRT…</button>
              <button class="btn primary small" id="addBtn">＋ 新增片段</button>
            </div>
          </div>
          <p class="meta">所有写操作都会携带你当前看到的修订号；修订号过期时服务端拒绝并返回冲突，绝不覆盖他人修改。</p>
          <div class="side-scroll">
            <table class="seg-table">
              <thead><tr><th>#</th><th>时间</th><th>文本</th><th>状态</th><th>操作</th></tr></thead>
              <tbody id="segTbody"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div>
        <section class="card" id="publishCard"></section>
      </div>
    </div>`;

  $('backLink').addEventListener('click', backToList);
  $('addBtn').addEventListener('click', () => openEditor('create'));
  $('importSrtBtn').addEventListener('click', openImportModal);
  $('restoreRangeBtn').addEventListener('click', openRestoreModal);
  const videoEl = $('videoPlayer');
  videoEl.addEventListener('timeupdate', onTimeUpdate);

  renderTimeline();
  renderSegmentTable();
  renderPublishCard();
}

// 仅刷新依赖片段数据的区域（轮询/写操作后），不重建 <video>
function renderSegmentDependent() {
  if (state.view !== 'detail') return;
  renderTimeline();
  renderSegmentTable();
  renderPublishCard();
  onTimeUpdate();
}

/* ---------- 时间轴 ---------- */
function renderTimeline() {
  const c = $('timelineContainer');
  if (!c) return;
  const duration = state.video.duration_ms;
  const pct = (ms) => `${Math.min(100, Math.max(0, (ms / duration) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    `<span style="left:${f * 100}%">${fmtTimeShort(f * duration)}</span>`).join('');

  c.innerHTML = `
    <div class="timeline-wrap">
      <div class="timeline-ruler">${ticks}</div>
      <div class="timeline" id="timeline">
        <div class="track" id="track">
          ${state.segments.map((s) => `
            <div class="seg-block ${s.reviewed ? 'reviewed' : 'draft'} ${state.activeSegmentId === s.id ? 'active' : ''}"
                 data-id="${s.id}" title="#${s.id} ${fmtTime(s.start_ms)} → ${fmtTime(s.end_ms)}&#10;${esc(s.text)}"
                 style="left:${pct(s.start_ms)};width:calc(${pct(s.end_ms - s.start_ms)} - 2px);">
              <div class="seg-label">${esc(s.text) || '(空文本)'}</div>
            </div>`).join('')}
        </div>
        <div class="playhead" id="playhead" style="left:0%"></div>
      </div>
    </div>`;

  const timeline = $('timeline');
  timeline.addEventListener('click', (e) => {
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const videoEl = currentVideoEl();
    if (videoEl) videoEl.currentTime = (ratio * state.video.duration_ms) / 1000;
  });
  c.querySelectorAll('.seg-block').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const seg = state.segments.find((s) => s.id === Number(el.dataset.id));
      if (!seg) return;
      state.activeSegmentId = seg.id;
      currentVideoEl().currentTime = seg.start_ms / 1000;
      renderSegmentDependent();
    });
  });
}

function onTimeUpdate() {
  const videoEl = currentVideoEl();
  const playhead = $('playhead');
  const overlay = $('subtitleOverlay');
  if (!videoEl || !playhead) return;
  const ms = videoEl.currentTime * 1000;
  playhead.style.left = `${Math.min(100, (ms / state.video.duration_ms) * 100)}%`;
  const seg = state.segments.find((s) => ms >= s.start_ms && ms < s.end_ms);
  if (overlay) overlay.textContent = seg ? seg.text : '';
  if (seg && seg.id !== state.activeSegmentId) {
    state.activeSegmentId = seg.id;
    document.querySelectorAll('.seg-block').forEach((el) =>
      el.classList.toggle('active', Number(el.dataset.id) === seg.id));
    document.querySelectorAll('#segTbody tr').forEach((tr) =>
      tr.classList.toggle('active', Number(tr.dataset.id) === seg.id));
  }
}

/* ---------- 片段表 ---------- */
function renderSegmentTable() {
  const tbody = $('segTbody');
  if (!tbody) return;
  if (!state.segments.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="meta">还没有片段，点击右上角「新增片段」。</td></tr>';
    return;
  }
  tbody.innerHTML = state.segments.map((s) => `
    <tr data-id="${s.id}" class="${state.activeSegmentId === s.id ? 'active' : ''}">
      <td>${s.id}</td>
      <td class="mono">${fmtTime(s.start_ms)}<br>→ ${fmtTime(s.end_ms)}</td>
      <td class="seg-text-cell">${esc(s.text) || '<span class="meta">(空)</span>'}
          <div class="mono" style="margin-top:3px">rev ${s.revision}</div></td>
      <td>${s.reviewed ? '<span class="tag ok">已审</span>' : '<span class="tag warn">待审</span>'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-act="seek">定位</button>
        <button class="btn small" data-act="edit">编辑</button>
        <button class="btn small ${s.reviewed ? 'ghost' : 'ok'}" data-act="review">${s.reviewed ? '取消审校' : '标记已审'}</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div></td>
    </tr>`).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const seg = state.segments.find((s) => s.id === id);
    tr.querySelector('[data-act=seek]').addEventListener('click', () => {
      state.activeSegmentId = id;
      currentVideoEl().currentTime = seg.start_ms / 1000;
      renderSegmentDependent();
    });
    tr.querySelector('[data-act=edit]').addEventListener('click', () => openEditor('edit', seg));
    tr.querySelector('[data-act=review]').addEventListener('click', () => toggleReview(seg));
    tr.querySelector('[data-act=del]').addEventListener('click', () => deleteSegment(seg));
  });
}

/* ================= 片段编辑弹窗 ================= */
function openEditor(mode, segment) {
  state.editor = { mode, segmentId: segment ? segment.id : null };
  $('editorError').textContent = '';
  $('editorReviewNote').classList.add('hidden');
  if (mode === 'create') {
    $('editorTitle').textContent = '新增片段';
    $('editorId').textContent = '新';
    $('editorRevision').textContent = '—';
    const start = currentMs();
    $('editStart').value = start;
    $('editEnd').value = Math.min(start + 3000, state.video.duration_ms);
    $('editText').value = '';
  } else {
    $('editorTitle').textContent = '编辑片段';
    $('editorId').textContent = segment.id;
    $('editorRevision').textContent = segment.revision;
    $('editorReviewNote').classList.toggle('hidden', !segment.reviewed);
    $('editStart').value = segment.start_ms;
    $('editEnd').value = segment.end_ms;
    $('editText').value = segment.text;
  }
  $('editorModal').classList.remove('hidden');
}

function closeEditor() {
  state.editor = null;
  $('editorModal').classList.add('hidden');
}

function editorInputs() {
  return {
    start_ms: Number($('editStart').value),
    end_ms: Number($('editEnd').value),
    text: $('editText').value,
  };
}

async function saveEditor() {
  const e = state.editor;
  if (!e) return;
  const body = editorInputs();
  $('editorError').textContent = '';
  try {
    let data;
    if (e.mode === 'create') {
      data = await api(`/api/videos/${state.video.id}/segments`, { method: 'POST', body });
      toast('片段已新增（待审）');
    } else {
      const seg = state.segments.find((s) => s.id === e.segmentId);
      data = await api(`/api/videos/${state.video.id}/segments/${e.segmentId}`, {
        method: 'PUT',
        body: { ...body, revision: seg.revision },
      });
      const wasReviewed = seg.reviewed;
      if (wasReviewed && !data.segment.reviewed) toast('已保存；因内容被修改，审校状态已撤销', true);
      else toast('片段已保存');
    }
    state.segments = data.segments;
    closeEditor();
    renderSegmentDependent();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.current) {
      closeEditor();
      showConflict(err.message, err.data.current, e);
      return;
    }
    // 422 等非法修改：保留弹窗与用户输入（原稿未被服务端改动）
    $('editorError').textContent = `未保存：${err.message}`;
  }
}

async function toggleReview(seg) {
  const target = !seg.reviewed;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}/review`, {
      method: 'POST',
      body: { reviewed: target, revision: seg.revision },
    });
    state.segments = data.segments;
    renderSegmentDependent();
    toast(target ? `片段 #${seg.id} 已标记审校` : `片段 #${seg.id} 已取消审校`);
  } catch (err) {
    if (err.status === 409) {
      toast('冲突：该片段已被他人修改，已刷新最新内容', true);
      await refreshCurrent();
    } else {
      toast(`操作失败：${err.message}`, true);
    }
  }
}

async function deleteSegment(seg) {
  if (!confirm(`确定删除片段 #${seg.id}？\n「${seg.text.slice(0, 60)}」\n删除需匹配修订号 rev ${seg.revision}`)) return;
  try {
    const data = await api(`/api/videos/${state.video.id}/segments/${seg.id}`, {
      method: 'DELETE',
      body: { revision: seg.revision },
    });
    state.segments = data.segments;
    renderSegmentDependent();
    toast('片段已删除');
  } catch (err) {
    if (err.status === 409) {
      toast('冲突：该片段已被他人修改，已刷新最新内容', true);
      await refreshCurrent();
    } else {
      toast(`删除失败：${err.message}`, true);
    }
  }
}

async function refreshCurrent() {
  const data = await api(`/api/videos/${state.video.id}`);
  state.segments = data.segments;
  state.publications = data.publications;
  renderSegmentDependent();
}

/* ---------- 冲突弹窗 ---------- */
function showConflict(message, current, editorCtx) {
  $('conflictMessage').textContent = message;
  $('conflictRevision').textContent = current.revision;
  $('conflictTime').textContent = `${fmtTime(current.start_ms)} → ${fmtTime(current.end_ms)}`;
  $('conflictText').textContent = current.text;
  $('conflictReviewed').classList.toggle('hidden', !current.reviewed);
  $('conflictNotReviewed').classList.toggle('hidden', current.reviewed);
  $('conflictModal').classList.remove('hidden');

  $('conflictDiscard').onclick = async () => {
    $('conflictModal').classList.add('hidden');
    await refreshCurrent();
  };
  $('conflictReload').onclick = async () => {
    $('conflictModal').classList.add('hidden');
    const fresh = state.segments.find((s) => s.id === current.id);
    if (editorCtx && editorCtx.mode === 'edit' && fresh) openEditor('edit', fresh);
  };
}

/* ================= 发布 / 下载 ================= */
function computeStatus() {
  const problems = [];
  if (state.segments.length === 0) problems.push('至少需要一个字幕片段才能发布');
  for (const s of state.segments) {
    if (s.start_ms < 0 || s.start_ms >= s.end_ms) problems.push(`片段 #${s.id} 起点必须早于终点`);
    if (s.end_ms > state.video.duration_ms) problems.push(`片段 #${s.id} 终点超过视频时长`);
  }
  const ordered = [...state.segments].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start_ms < ordered[i - 1].end_ms) {
      problems.push(`片段 #${ordered[i - 1].id} 与 #${ordered[i].id} 时间重叠`);
    }
  }
  if (state.segments.some((s) => !s.reviewed)) problems.push('仍有片段未通过审校');
  return {
    canPublish: problems.length === 0,
    problems,
    reviewedCount: state.segments.filter((s) => s.reviewed).length,
  };
}

function renderPublishCard() {
  const card = $('publishCard');
  if (!card) return;
  const status = computeStatus();
  card.innerHTML = `
    <h2>发布与下载</h2>
    <p class="meta">发布生成不可变版本快照；发布后再编辑只影响草稿，不影响历史版本。</p>
    <ul class="status-list">
      <li class="${state.segments.length ? 'good' : 'bad'}">片段数量：${state.segments.length}（至少 1 段）</li>
      <li class="${status.reviewedCount === state.segments.length && state.segments.length ? 'good' : 'bad'}">
        审校进度：${status.reviewedCount}/${state.segments.length}</li>
      ${status.problems.filter((p) => !p.includes('未通过审校') && !p.includes('至少需要')).map((p) =>
        `<li class="bad">时间问题：${esc(p)}</li>`).join('')}
    </ul>
    <div class="publish-bar">
      <button class="btn primary" id="publishBtn" ${status.canPublish ? '' : 'disabled'}>发布新版本</button>
      <div class="dropdown">
        <button class="btn" id="downloadBtn">下载 SRT ▾</button>
        <div class="dropdown-menu hidden" id="downloadMenu"></div>
      </div>
    </div>
    <div class="pub-list" id="pubList"></div>`;

  $('publishBtn').addEventListener('click', publishVersion);

  const menu = $('downloadMenu');  const items = ['<div class="label">草稿（当前编辑内容）</div>',
    `<a href="/api/videos/${state.video.id}/srt?version=draft">草稿 SRT</a>`];
  if (state.publications.length) {
    items.push('<div class="label" style="margin-top:6px">已发布版本（不可变）</div>');
    items.push(`<a href="/api/videos/${state.video.id}/srt?version=published">最新已发布 v${state.publications[0].version} SRT</a>`);
    for (const p of state.publications) {
      items.push(`<a href="/api/videos/${state.video.id}/srt?version=${p.version}">v${p.version}（${new Date(p.published_at).toLocaleString()}，${p.segment_count} 段）</a>`);
    }
  } else {
    items.push('<div class="label" style="margin-top:6px;color:var(--warn)">尚无已发布版本</div>');
  }
  menu.innerHTML = items.join('');
  $('downloadBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });

  const pubList = $('pubList');
  pubList.innerHTML = state.publications.length
    ? '历史发布：' + state.publications
        .map((p) => `v${p.version} · ${new Date(p.published_at).toLocaleString()} · ${p.segment_count} 段`)
        .join(' ｜ ')
    : '尚未发布过版本';
}

async function publishVersion() {
  try {
    const data = await api(`/api/videos/${state.video.id}/publish`, { method: 'POST' });
    toast(`已发布不可变版本 v${data.publication.version}`);
    await refreshCurrent();
  } catch (err) {
    toast(`发布失败：${err.message}`, true);
  }
}

/* ================= SRT 导入 ================= */
const IMPORT_PREVIEW_LIMIT = 200;
const importState = { content: null, filename: null, preview: null, busy: false };

function openImportModal() {
  importState.content = null;
  importState.filename = null;
  importState.preview = null;
  importState.busy = false;
  $('importFile').value = '';
  $('importFileMsg').textContent = '';
  $('importError').textContent = '';
  $('importResult').classList.add('hidden');
  $('importAppendBtn').disabled = true;
  $('importReplaceBtn').disabled = true;
  $('importModal').classList.remove('hidden');
}
function closeImportModal() {
  $('importModal').classList.add('hidden');
}

async function previewImport() {
  const file = $('importFile').files[0];
  $('importError').textContent = '';
  if (!file) { $('importError').textContent = '请先选择 .srt 文件'; return; }
  $('importFileMsg').textContent = `正在解析 ${file.name}…`;
  // 预览与确认都发送同一份解码文本（浏览器 UTF-8 解码会去掉 BOM），保证内容指纹一致
  const content = await file.text();
  importState.content = content;
  importState.filename = file.name;
  try {
    const fd = new FormData();
    fd.append('srt', new Blob([content], { type: 'text/plain' }), file.name);
    const data = await api(`/api/videos/${state.video.id}/srt/preview`, { method: 'POST', body: fd });
    importState.preview = data;
    renderImportPreview(data);
  } catch (err) {
    importState.preview = null;
    $('importResult').classList.add('hidden');
    $('importAppendBtn').disabled = true;
    $('importReplaceBtn').disabled = true;
    renderImportErrors(err);
  } finally {
    $('importFileMsg').textContent = '';
  }
}

function renderImportErrors(err, prefix = '预览失败，未写入任何内容：') {
  const errs = err.data && Array.isArray(err.data.errors) ? err.data.errors : [];
  let msg = `${prefix}${err.message}`;
  if (errs.length > 1) msg += `\n（共 ${errs.length} 处问题，以下列出前 20 条）`;
  const detail = errs.slice(0, 20).map((e) => `· ${e.message}`).join('\n');
  $('importError').textContent = detail ? `${msg}\n${detail}` : msg;
}

function renderImportPreview(data) {
  $('importError').textContent = '';
  $('importResult').classList.remove('hidden');

  const conflictBox = $('importConflictBox');
  if (data.conflicts.length) {
    conflictBox.classList.remove('hidden');
    $('importConflictList').innerHTML = data.conflicts.slice(0, 20)
      .map((c) => `<li>${esc(c.message)}</li>`).join('') +
      (data.conflicts.length > 20 ? `<li>… 其余 ${data.conflicts.length - 20} 条从略</li>` : '');
  } else {
    conflictBox.classList.add('hidden');
  }

  $('importSummary').innerHTML =
    `文件 <b>${esc(data.filename)}</b> 解析出 <b>${data.imported_count}</b> 个条目` +
    `（序号可不连续）；当前草稿 <b>${data.draft_count}</b> 段。` +
    (data.conflicts.length
      ? `<br><span class="warn">与草稿存在 ${data.conflicts.length} 处时间冲突 —— 追加被阻止，可改用替换。</span>`
      : '<br><span style="color:var(--ok)">与当前草稿无时间冲突，可直接追加。</span>');

  const shown = data.entries.slice(0, IMPORT_PREVIEW_LIMIT);
  $('importTbody').innerHTML = shown.map((e) => {
    const clash = data.conflicts.some((c) => c.entry === e.entry);
    return `
    <tr class="${clash ? 'import-conflict' : ''}">
      <td>${e.entry}</td>
      <td class="mono">${e.seq == null ? '(缺)' : e.seq}</td>
      <td class="mono">第 ${e.line} 行</td>
      <td class="mono">${fmtTime(e.start_ms)}<br>→ ${fmtTime(e.end_ms)}</td>
      <td class="seg-text-cell">${esc(e.text) || '<span class="meta">(空)</span>'}</td>
    </tr>`;
  }).join('');
  const hint = $('importMoreHint');
  if (data.entries.length > IMPORT_PREVIEW_LIMIT) {
    hint.classList.remove('hidden');
    hint.textContent = `仅显示前 ${IMPORT_PREVIEW_LIMIT} 条，共 ${data.entries.length} 条；确认时会整批写入。`;
  } else {
    hint.classList.add('hidden');
  }

  // 追加在有冲突时禁用；替换始终可用（条目已通过全部校验）
  $('importAppendBtn').disabled = data.append_blocked;
  $('importReplaceBtn').disabled = false;
}

async function confirmImport(mode) {
  if (importState.busy || !importState.preview) return;
  const p = importState.preview;
  if (mode === 'replace' &&
      !confirm(`替换将先删除当前草稿的全部 ${p.draft_count} 个片段，再写入导入的 ${p.imported_count} 个待审片段。\n已发布的历史版本不受影响。确定继续？`)) {
    return;
  }
  importState.busy = true;
  const btns = [$('importAppendBtn'), $('importReplaceBtn')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    const fd = new FormData();
    fd.append('srt', new Blob([importState.content], { type: 'text/plain' }), importState.filename || 'import.srt');
    fd.append('mode', mode);
    fd.append('token', p.token);
    const data = await api(`/api/videos/${state.video.id}/srt/import`, { method: 'POST', body: fd });
    state.segments = data.segments;
    closeImportModal();
    renderSegmentDependent();
    toast(`${mode === 'append' ? '已追加' : '已替换草稿并写入'} ${data.imported_count} 个待审片段`);
  } catch (err) {
    if (err.status === 409 && err.data && Array.isArray(err.data.current_segments)) {
      // 预览后草稿被修改：拒绝覆盖，自动用最新草稿重新预览同一份 SRT
      const changedMsg = `⚠️ ${err.message}`;
      state.segments = err.data.current_segments;
      renderSegmentDependent();
      try {
        const fd = new FormData();
        fd.append('srt', new Blob([importState.content], { type: 'text/plain' }), importState.filename || 'import.srt');
        const re = await api(`/api/videos/${state.video.id}/srt/preview`, { method: 'POST', body: fd });
        importState.preview = re;
        renderImportPreview(re);
      } catch (e2) {
        renderImportErrors(e2);
      }
      $('importError').textContent = `${changedMsg}\n已按最新草稿重新预览，请核对后再次操作。`;
      toast('预览后草稿发生了变化，请重新核对预览', true);
      return;
    }
    renderImportErrors(err, '确认失败，未写入任何内容：');
    // 422（如 SRT 内容变化）后恢复按钮可用性由预览状态决定
    if (importState.preview) {
      $('importAppendBtn').disabled = importState.preview.append_blocked;
      $('importReplaceBtn').disabled = false;
    }
  } finally {
    importState.busy = false;
  }
}

/* ================= 历史版本区间恢复 ================= */
const restoreState = { preview: null, busy: false };

function openRestoreModal() {
  restoreState.preview = null;
  restoreState.busy = false;
  const sel = $('restoreVersion');
  sel.innerHTML = state.publications.length
    ? state.publications
        .map((p) => `<option value="${p.version}">v${p.version}（${new Date(p.published_at).toLocaleString()}，${p.segment_count} 段）</option>`)
        .join('')
    : '<option value="">（尚无已发布版本）</option>';
  $('restoreStart').value = 0;
  $('restoreEnd').value = state.video.duration_ms;
  $('restoreError').textContent = '';
  $('restoreResult').classList.add('hidden');
  $('restoreConfirmBtn').disabled = true;
  $('restoreModal').classList.remove('hidden');
}
function closeRestoreModal() {
  $('restoreModal').classList.add('hidden');
}

// 版本或区间被改动后，旧预览令牌不再匹配，必须重新预览
function invalidateRestorePreview() {
  restoreState.preview = null;
  $('restoreResult').classList.add('hidden');
  $('restoreConfirmBtn').disabled = true;
}

function restoreParams() {
  return {
    version: Number($('restoreVersion').value),
    start_ms: Number($('restoreStart').value),
    end_ms: Number($('restoreEnd').value),
  };
}

async function previewRestore() {
  $('restoreError').textContent = '';
  invalidateRestorePreview();
  if (!state.publications.length) {
    $('restoreError').textContent = '该视频还没有已发布版本，请先在右侧「发布与下载」发布一个版本。';
    return;
  }
  try {
    const data = await api(`/api/videos/${state.video.id}/restore/preview`, { method: 'POST', body: restoreParams() });
    restoreState.preview = data;
    renderRestorePreview(data);
  } catch (err) {
    renderRestoreError(err, '预览失败：');
  }
}

function renderRestoreError(err, prefix) {
  const crossings = err.data && Array.isArray(err.data.crossings) ? err.data.crossings : [];
  let msg = `${prefix}${err.message}`;
  if (crossings.length > 1) msg += `\n（共 ${crossings.length} 处边界穿过，需全部调整）`;
  const detail = crossings.slice(0, 20).map((c) => `· ${c.message}`).join('\n');
  $('restoreError').textContent = detail ? `${msg}\n${detail}` : msg;
}

function renderRestorePreview(data) {
  $('restoreResult').classList.remove('hidden');
  $('restoreSummary').innerHTML =
    `将用发布版本 <b>v${data.version}</b> 在 <b>${fmtTime(data.start_ms)} → ${fmtTime(data.end_ms)}</b> 区间内的 ` +
    `<b>${data.to_restore.length}</b> 个片段，整体替换当前草稿该区间的 <b>${data.to_remove.length}</b> 个片段；` +
    '恢复片段均为<b>待审</b>新片段，区间外草稿片段与修订号不变。';
  $('restorePubTitle').textContent = `发布快照 v${data.version}（区间内 ${data.to_restore.length} 段，确认后恢复为待审）`;
  $('restorePubTbody').innerHTML = data.to_restore.length
    ? data.to_restore.map((e) => `
      <tr>
        <td class="mono">第 ${e.snapshot_index} 条</td>
        <td class="mono">${fmtTime(e.start_ms)}<br>→ ${fmtTime(e.end_ms)}</td>
        <td class="seg-text-cell">${esc(e.text) || '<span class="meta">(空)</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="meta">该区间内发布快照没有片段（确认后区间内草稿片段将被清空）。</td></tr>';
  $('restoreDraftTbody').innerHTML = data.to_remove.length
    ? data.to_remove.map((s) => `
      <tr>
        <td>${s.id}</td>
        <td class="mono">${fmtTime(s.start_ms)}<br>→ ${fmtTime(s.end_ms)}</td>
        <td class="seg-text-cell">${esc(s.text) || '<span class="meta">(空)</span>'}</td>
        <td>${s.reviewed ? '<span class="tag ok">已审</span>' : '<span class="tag warn">待审</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="meta">该区间内当前草稿没有片段。</td></tr>';
  $('restoreConfirmBtn').disabled = false;
}

async function confirmRestore() {
  if (restoreState.busy || !restoreState.preview) return;
  const p = restoreState.preview;
  if (!confirm(`确定用 v${p.version} 在 ${fmtTime(p.start_ms)} → ${fmtTime(p.end_ms)} 区间内的 ${p.to_restore.length} 个片段，` +
    `整体替换草稿该区间的 ${p.to_remove.length} 个片段？\n恢复片段均为待审；区间外草稿与历史发布版本不受影响。`)) {
    return;
  }
  restoreState.busy = true;
  $('restoreConfirmBtn').disabled = true;
  try {
    const data = await api(`/api/videos/${state.video.id}/restore/confirm`, {
      method: 'POST',
      body: { version: p.version, start_ms: p.start_ms, end_ms: p.end_ms, token: p.token },
    });
    state.segments = data.segments;
    closeRestoreModal();
    renderSegmentDependent();
    toast(`已恢复区间：移除 ${data.removed_count} 段、恢复 ${data.restored_count} 段（均为待审）`);
  } catch (err) {
    if (err.status === 409 && err.data && Array.isArray(err.data.current_segments)) {
      // 预览后草稿被修改：拒绝覆盖，按最新草稿自动重新预览同一版本与区间
      const changedMsg = `⚠️ ${err.message}`;
      state.segments = err.data.current_segments;
      renderSegmentDependent();
      try {
        const re = await api(`/api/videos/${state.video.id}/restore/preview`, {
          method: 'POST',
          body: { version: p.version, start_ms: p.start_ms, end_ms: p.end_ms },
        });
        restoreState.preview = re;
        renderRestorePreview(re);
        $('restoreError').textContent = `${changedMsg}\n已按最新草稿重新预览，请核对后再次确认。`;
      } catch (e2) {
        invalidateRestorePreview();
        renderRestoreError(e2, '草稿已变化，按相同条件重新预览失败：');
      }
      toast('预览后草稿发生了变化，请重新核对预览', true);
      return;
    }
    renderRestoreError(err, '确认失败，未写入任何内容：');
    if (restoreState.preview) $('restoreConfirmBtn').disabled = false;
  } finally {
    restoreState.busy = false;
  }
}

/* ================= 弹窗事件绑定 ================= */
document.addEventListener('click', (e) => {
  const menu = $('downloadMenu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'downloadBtn') {
    menu.classList.add('hidden');
  }
});
$('editorCancel').addEventListener('click', closeEditor);
$('editorSave').addEventListener('click', saveEditor);
$('editStartNow').addEventListener('click', () => { $('editStart').value = currentMs(); });
$('editEndNow').addEventListener('click', () => { $('editEnd').value = currentMs(); });
$('editorModal').addEventListener('click', (e) => { if (e.target === $('editorModal')) closeEditor(); });
$('importCancel').addEventListener('click', closeImportModal);
$('importPreviewBtn').addEventListener('click', previewImport);
$('importAppendBtn').addEventListener('click', () => confirmImport('append'));
$('importReplaceBtn').addEventListener('click', () => confirmImport('replace'));
$('importModal').addEventListener('click', (e) => { if (e.target === $('importModal')) closeImportModal(); });
$('importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  $('importFileMsg').textContent = f ? `已选择 ${f.name}（${(f.size / 1024).toFixed(1)} KB），点击「解析并预览」` : '';
});
$('restoreCancel').addEventListener('click', closeRestoreModal);
$('restorePreviewBtn').addEventListener('click', previewRestore);
$('restoreConfirmBtn').addEventListener('click', confirmRestore);
$('restoreModal').addEventListener('click', (e) => { if (e.target === $('restoreModal')) closeRestoreModal(); });
['restoreVersion', 'restoreStart', 'restoreEnd'].forEach((id) => {
  $(id).addEventListener('input', invalidateRestorePreview);
  $(id).addEventListener('change', invalidateRestorePreview);
});

/* ================= 启动 ================= */
loadList().catch((e) => {
  app.innerHTML = `<div class="card"><h2>加载失败</h2><p class="error">${esc(e.message)}</p></div>`;
});
