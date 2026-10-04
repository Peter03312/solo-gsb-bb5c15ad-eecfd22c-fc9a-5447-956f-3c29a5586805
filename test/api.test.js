'use strict';

// 端到端业务规则测试：启动真实 HTTP 服务 + 临时 SQLite，不依赖外部框架
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/api`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-desk-test-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function req(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw) { opts.body = raw; }
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, json, ok: res.ok, text: json ? null : null };
}

// multipart 上传构造（避免引入额外依赖）
function multipartVideo(filePath, fields) {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n`));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadVideo(title, durationMs, fileSize) {
  const f = path.join(tmpDir, `v-${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(fileSize, 0x78));
  const { body, contentType } = multipartVideo(f, { title, duration_ms: String(durationMs) });
  const res = await fetch(`${BASE}/videos`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  const json = await res.json();
  check('上传返回 201', res.status === 201, JSON.stringify(json));
  return json.video;
}

async function main() {
  console.log('1. 上传与基本校验');
  const v = await uploadVideo('测试视频', 10000, 256);
  eq('时长被记录', v.duration_ms, 10000);

  const badDur = await req('POST', `/videos/${v.id}/segments`, { start_ms: 0, end_ms: -1, text: '' });
  check('负数终点 -> 422', badDur.status === 422);

  {
    const f = path.join(tmpDir, 'bad.mp4');
    fs.writeFileSync(f, Buffer.alloc(16));
    const mp = multipartVideo(f, { title: '坏时长', duration_ms: '-5' });
    const res = await fetch(`${BASE}/videos`, { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body });
    const json = await res.json();
    check('非法时长 422', res.status === 422, JSON.stringify(json));
  }

  console.log('2. 片段增删改与时间合法性');
  let r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '第一句' });
  check('新增片段 201', r.status === 201);
  const s1 = r.json.segment;
  eq('新片段默认待审', s1.reviewed, false);
  eq('初始修订号为 1', s1.revision, 1);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 3000, end_ms: 2500, text: '反了' });
  check('起点晚于终点 -> 422', r.status === 422 && /起点必须早于终点/.test(r.json.error.message), r.json && r.json.error.message);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 0, end_ms: 12000, text: '超长' });
  check('终点超过视频时长 -> 422', r.status === 422 && /超过视频时长/.test(r.json.error.message), r.json && r.json.error.message);

  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 1500, end_ms: 2500, text: '重叠' });
  check('时间重叠 -> 422', r.status === 422 && /重叠/.test(r.json.error.message), r.json && r.json.error.message);

  // 非法修改后原稿仍在
  let list = (await req('GET', `/videos/${v.id}`)).json.segments;
  eq('非法修改未写入，原稿保留', list.map((x) => [x.start_ms, x.end_ms, x.text]), [[1000, 2000, '第一句']]);

  // 端点相接允许
  r = await req('POST', `/videos/${v.id}/segments`, { start_ms: 2000, end_ms: 3000, text: '第二句' });
  check('端点相接不算重叠 201', r.status === 201);
  const s2 = r.json.segment;

  console.log('3. 乐观锁修订号与冲突');
  // A 先改成功，revision 1 -> 2
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(改)', revision: 1 });
  check('携带正确修订号修改成功', r.status === 200);
  eq('修订号递增', r.json.segment.revision, 2);

  // B 拿着过期 revision=1 再改
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '覆盖尝试', revision: 1 });
  check('过期修订号 -> 409 冲突', r.status === 409, r.json && r.json.error.message);
  eq('冲突返回当前内容', r.json && r.json.error.current.text, '第一句(改)');
  eq('冲突返回当前修订号', r.json && r.json.error.current.revision, 2);

  // 过期内容没有覆盖他人修改
  list = (await req('GET', `/videos/${v.id}`)).json.segments;
  eq('他人修改未被覆盖', list.find((x) => x.id === s1.id).text, '第一句(改)');

  // 缺少修订号
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '无修订号' });
  check('缺少修订号 -> 422', r.status === 422);

  // 审校操作也要修订号；过期冲突
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 1 });
  check('过期修订号审校 -> 409', r.status === 409);

  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 2 });
  check('正确修订号审校成功', r.status === 200 && r.json.segment.reviewed === true);
  eq('审校后修订号为 3', r.json.segment.revision, 3);

  console.log('4. 修改已审片段撤销审校状态');
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, { start_ms: 1000, end_ms: 2000, text: '第一句(再改)', revision: 3 });
  check('编辑已审片段成功', r.status === 200);
  eq('审校状态被撤销', r.json.segment.reviewed, false);
  eq('修订号递增到 4', r.json.segment.revision, 4);

  // 删除同样受修订号保护
  r = await req('DELETE', `/videos/${v.id}/segments/${s2.id}`, { revision: 999 });
  check('过期修订号删除 -> 409', r.status === 409);
  list = (await req('GET', `/videos/${v.id}`)).json.segments;
  check('冲突删除未生效', list.some((x) => x.id === s2.id));

  console.log('5. 发布门禁与不可变版本');
  // 重新审校 s1（当前 rev 4）
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: 4 });
  check('s1 重新审校成功', r.status === 200);

  // s2 未审 -> 不能发布
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('存在未审片段时不能发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));

  // 空视频不能发布
  const empty = await uploadVideo('空视频', 5000, 32);
  r = await req('POST', `/videos/${empty.id}/publish`, {});
  check('无片段不能发布 -> 422', r.status === 422 && /至少需要一个/.test(r.json.error.message));

  // 审校 s2（rev 1）
  r = await req('POST', `/videos/${v.id}/segments/${s2.id}/review`, { reviewed: true, revision: 1 });
  check('s2 审校成功', r.status === 200);

  // 状态接口
  r = await req('GET', `/videos/${v.id}/status`);
  check('全部已审且时间合法时 canPublish', r.json.canPublish === true, JSON.stringify(r.json));

  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('发布成功 201', r.status === 201, JSON.stringify(r.json));
  eq('首个版本号为 1', r.json.publication.version, 1);

  // 草稿 SRT
  let srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=draft`);
  let srt = await srtRes.text();
  check('草稿 SRT 含序号与时间戳', /1\n00:00:01,000 --> 00:00:02,000/.test(srt), JSON.stringify(srt));
  check('SRT 含第二句', /2\n00:00:02,000 --> 00:00:03,000/.test(srt));

  // 已发布 SRT
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=published`);
  srt = await srtRes.text();
  check('已发布 SRT 可下载', srtRes.status === 200 && /第一句\(再改\)/.test(srt));

  // 发布后编辑只影响草稿
  const s1cur = (await req('GET', `/videos/${v.id}`)).json.segments.find((x) => x.id === s1.id);
  r = await req('PUT', `/videos/${v.id}/segments/${s1.id}`, {
    start_ms: 1000, end_ms: 2000, text: '发布后的草稿改动', revision: s1cur.revision,
  });
  check('发布后仍可编辑草稿', r.status === 200);
  eq('编辑草稿再次撤销审校', r.json.segment.reviewed, false);

  srt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=published`)).text();
  check('已发布版本保持不可变', /第一句\(再改\)/.test(srt) && !/草稿改动/.test(srt));
  srt = await (await fetch(`${BASE}/videos/${v.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映最新编辑', /草稿改动/.test(srt));

  // 指定版本号与不存在版本
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=1`);
  check('按版本号下载 v1', srtRes.status === 200);
  srtRes = await fetch(`${BASE}/videos/${v.id}/srt?version=99`);
  check('不存在版本 -> 404', srtRes.status === 404);
  srtRes = await fetch(`${BASE}/videos/${empty.id}/srt?version=published`);
  check('无发布版本 -> 404', srtRes.status === 404);

  // 审校状态不完整时不能发布 v2
  r = await req('POST', `/videos/${v.id}/publish`, {});
  check('新草稿未全部审校时不能发 v2 -> 422', r.status === 422);

  // 重新审校后发布 v2
  const s1now = (await req('GET', `/videos/${v.id}`)).json.segments.find((x) => x.id === s1.id);
  r = await req('POST', `/videos/${v.id}/segments/${s1.id}/review`, { reviewed: true, revision: s1now.revision });
  check('s1 再审校', r.status === 200);
  r = await req('POST', `/videos/${v.id}/publish`, {});
  eq('第二个不可变版本号为 2', r.json.publication.version, 2);

  const pubs = (await req('GET', `/videos/${v.id}/publications`)).json.publications;
  eq('版本列表为 [2,1]', pubs.map((p) => p.version), [2, 1]);

  console.log('6. 视频媒体流 Range');
  const rangeRes = await fetch(`http://127.0.0.1:${PORT}/api/videos/${v.id}/media`, { headers: { Range: 'bytes=0-15' } });
  check('Range 请求返回 206', rangeRes.status === 206);
  eq('Content-Range 正确', rangeRes.headers.get('content-range'), 'bytes 0-15/256');

  await srtImportTests();
  await restoreTests();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

async function srtPreview(videoId, content, filename = 'x.srt') {
  const fd = new FormData();
  fd.append('srt', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`${BASE}/videos/${videoId}/srt/preview`, { method: 'POST', body: fd });
  const json = await res.json();
  return { status: res.status, json };
}

async function srtImport(videoId, content, mode, token) {
  const fd = new FormData();
  fd.append('srt', new Blob([content], { type: 'text/plain' }), 'x.srt');
  fd.append('mode', mode);
  fd.append('token', token);
  const res = await fetch(`${BASE}/videos/${videoId}/srt/import`, { method: 'POST', body: fd });
  const json = await res.json();
  return { status: res.status, json };
}

async function srtImportTests() {
  console.log('7. SRT 导入：解析与错误条目（不写入）');
  const w = await uploadVideo('导入测试', 10000, 64);

  // 合法 SRT：UTF-8 BOM、CRLF、序号不连续(1,5)、多行文本
  const good = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n第二行\r\n\r\n' +
               '5\r\n00:00:03.000 --> 00:00:04,000\r\n不连续序号也行\r\n';
  let p = await srtPreview(w.id, good);
  check('合法 SRT 预览 200', p.status === 200, JSON.stringify(p.json));
  eq('解析出 2 个条目', p.json.imported_count, 2);
  eq('保留原文件行号', p.json.entries.map((e) => [e.seq, e.line, e.start_ms, e.end_ms]),
    [[1, 1, 1000, 2000], [5, 6, 3000, 4000]]);
  eq('多行文本被保留', p.json.entries[0].text, '你好\n第二行');
  check('空草稿无冲突', p.json.conflicts.length === 0 && p.json.append_blocked === false);

  // 空文件
  p = await srtPreview(w.id, '');
  check('空 SRT -> 422', p.status === 422 && p.json.error.code === 'invalid_srt');
  check('空 SRT 错误码 empty_srt', p.json.error.errors[0].code === 'empty_srt');

  // 仅 BOM 与空白
  p = await srtPreview(w.id, '﻿\n  \n\r\n');
  check('仅空白 SRT -> 422 empty_srt', p.status === 422 && p.json.error.errors[0].code === 'empty_srt');

  // 坏时间戳（含 --> 但结构不符合 HH:MM:SS,mmm --> HH:MM:SS,mmm）
  p = await srtPreview(w.id, '1\n00:01,000 --> 00:02,000\n坏');
  check('坏时间戳 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'bad_timestamp'),
    JSON.stringify(p.json.error));
  check('错误带行号', p.json.error.errors[0].line === 2);

  // 缺序号
  p = await srtPreview(w.id, '00:00:01,000 --> 00:00:02,000\n无序号');
  check('缺序号 -> 422 bad_index', p.status === 422 && p.json.error.errors.some((e) => e.code === 'bad_index'));

  // 缺时间戳
  p = await srtPreview(w.id, '1\n只有序号和文本');
  check('缺时间戳 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'missing_timestamp'));

  // 负时间（- 号被识别后由语义校验报 negative_time）
  p = await srtPreview(w.id, '1\n-00:00:01,000 --> 00:00:02,000\n负');
  check('负时间 -> 422 negative_time', p.status === 422 && p.json.error.errors.some((e) => e.code === 'negative_time'),
    JSON.stringify(p.json.error));

  // 起止倒置
  p = await srtPreview(w.id, '1\n00:00:05,000 --> 00:00:02,000\n倒置');
  check('起止倒置 -> 422 reversed_time', p.status === 422 && p.json.error.errors.some((e) => e.code === 'reversed_time'));

  // 零时长
  p = await srtPreview(w.id, '1\n00:00:02,000 --> 00:00:02,000\n零长');
  check('起点等于终点 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'reversed_time'));

  // 越过视频时长
  p = await srtPreview(w.id, '1\n00:00:09,000 --> 00:00:11,000\n超长');
  check('越过视频时长 -> 422 beyond_duration', p.status === 422 && p.json.error.errors.some((e) => e.code === 'beyond_duration'),
    JSON.stringify(p.json.error));

  // 分秒超范围
  p = await srtPreview(w.id, '1\n00:00:61,000 --> 00:00:62,000\n超秒');
  check('秒数 61 -> 422', p.status === 422 && p.json.error.errors.some((e) => e.code === 'bad_time_component'));

  // 导入条目之间重叠
  p = await srtPreview(w.id, '1\n00:00:01,000 --> 00:00:03,000\na\n\n2\n00:00:02,000 --> 00:00:04,000\nb');
  check('导入条目互相重叠 -> 422 imported_overlap',
    p.status === 422 && p.json.error.errors.some((e) => e.code === 'imported_overlap'), JSON.stringify(p.json.error));

  // 端点相接允许
  p = await srtPreview(w.id, '1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb');
  check('导入条目端点相接预览成功', p.status === 200);

  // 所有失败预览后没有任何片段写入
  let list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('失败预览零写入', list.length, 0);

  console.log('8. SRT 追加、替换与冲突');
  // 先放一段现有草稿 0-2s
  let r = await req('POST', `/videos/${w.id}/segments`, { start_ms: 0, end_ms: 2000, text: '原稿' });
  check('准备原稿片段 201', r.status === 201);

  // 导入 2s-4s（相接）与 5s-6s：可追加
  const okSrt = '1\n00:00:02,000 --> 00:00:04,000\n导入一\n\n3\n00:00:05,000 --> 00:00:06,000\n导入二';
  p = await srtPreview(w.id, okSrt);
  check('相接片段预览成功', p.status === 200);
  eq('预览报告草稿 1 段', p.json.draft_count, 1);

  // 无令牌 / 错模式（先于成功追加验证，避免草稿指纹变化）
  r = await srtImport(w.id, okSrt, 'append', 'garbage.token');
  check('坏令牌 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  {
    const fd = new FormData();
    fd.append('srt', new Blob([okSrt], { type: 'text/plain' }), 'x.srt');
    fd.append('mode', 'merge');
    fd.append('token', p.json.token);
    const res = await fetch(`${BASE}/videos/${w.id}/srt/import`, { method: 'POST', body: fd });
    const json = await res.json();
    check('非法 mode -> 422', res.status === 422 && json.error.code === 'invalid_mode');
  }

  // 内容与预览不一致（草稿未变，仅内容指纹不符 -> 422）
  const otherSrt = '1\n00:00:02,000 --> 00:00:03,500\n改了内容';
  r = await srtImport(w.id, otherSrt, 'append', p.json.token);
  check('内容与预览不符 -> 422 srt_changed', r.status === 422 && r.json.error.code === 'srt_changed');
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('不符内容未写入', list.some((x) => x.text === '改了内容'), false);

  r = await srtImport(w.id, okSrt, 'append', p.json.token);
  check('追加成功 201', r.status === 201, JSON.stringify(r.json));
  eq('追加后共 3 段', r.json.segments.length, 3);
  check('导入片段全部待审', r.json.segments.filter((x) => x.text.startsWith('导入')).every((x) => x.reviewed === false));
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('原稿仍在', list.some((x) => x.text === '原稿'), true);

  // 与草稿冲突的预览：追加被阻止
  const clashSrt = '1\n00:00:01,000 --> 00:00:02,500\n冲突条目';
  p = await srtPreview(w.id, clashSrt);
  check('冲突预览仍 200 且给出冲突', p.status === 200 && p.json.conflicts.length >= 1 && p.json.append_blocked === true,
    JSON.stringify(p.json));
  check('冲突带双方定位', /原稿/.test('') || /片段/.test(p.json.conflicts[0].message), p.json.conflicts[0].message);
  r = await srtImport(w.id, clashSrt, 'append', p.json.token);
  check('冲突追加 -> 422 draft_conflict', r.status === 422 && r.json.error.errors.some((e) => e.code === 'draft_conflict'));
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('冲突追加零写入', list.some((x) => x.text === '冲突条目'), false);

  // 同一冲突文件替换可以成功
  r = await srtImport(w.id, clashSrt, 'replace', p.json.token);
  check('冲突文件替换成功 201', r.status === 201, JSON.stringify(r.json));
  eq('替换后仅剩导入片段', r.json.segments.length, 1);
  eq('替换后内容为导入', r.json.segments[0].text, '冲突条目');
  eq('替换后为待审', r.json.segments[0].reviewed, false);
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('原稿已被删除', list.some((x) => x.text === '原稿'), false);

  console.log('9. SRT 导入：预览后草稿被改 -> 确认拒绝整批');
  // 再预览一份可追加内容
  const addSrt = '1\n00:00:03,000 --> 00:00:04,000\n后加的';
  p = await srtPreview(w.id, addSrt);
  check('可追加内容预览成功', p.status === 200 && p.json.append_blocked === false, JSON.stringify(p.json));
  // 模拟他人修改草稿（新增片段）
  r = await req('POST', `/videos/${w.id}/segments`, { start_ms: 2500, end_ms: 2800, text: '他人改动' });
  check('预览后他人新增片段 201', r.status === 201);
  r = await srtImport(w.id, addSrt, 'append', p.json.token);
  check('过期预览确认 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed',
    JSON.stringify(r.json));
  check('冲突返回当前片段', Array.isArray(r.json.error.current_segments) && r.json.error.current_segments.length === 2);
  list = (await req('GET', `/videos/${w.id}`)).json.segments;
  eq('过期确认零写入，他人改动保留', list.some((x) => x.text === '他人改动') && !list.some((x) => x.text === '后加的'), true);

  // 重新预览后确认成功（事务整批写入）
  p = await srtPreview(w.id, addSrt);
  r = await srtImport(w.id, addSrt, 'append', p.json.token);
  check('重新预览后追加成功', r.status === 201 && r.json.imported_count === 1, JSON.stringify(r.json));

  // JSON content 方式也可用
  p = await req('POST', `/videos/${w.id}/srt/preview`, {
    content: '1\n00:00:06,000 --> 00:00:07,000\nJSON 通道',
  });
  check('JSON content 预览 200', p.status === 200);
  r = await req('POST', `/videos/${w.id}/srt/import`, {
    content: '1\n00:00:06,000 --> 00:00:07,000\nJSON 通道',
    mode: 'append',
    token: p.json.token,
  });
  check('JSON content 追加成功', r.status === 201 && r.json.segments.some((x) => x.text === 'JSON 通道'), JSON.stringify(r.json));

  console.log('10. SRT 导入不影响发布版本与既有功能');
  // 在另一视频上发布版本后替换草稿，已发布版本保持不变
  const pv = await uploadVideo('发布保护', 5000, 48);
  await req('POST', `/videos/${pv.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '定稿' });
  const segId = (await req('GET', `/videos/${pv.id}`)).json.segments[0].id;
  await req('POST', `/videos/${pv.id}/segments/${segId}/review`, { reviewed: true, revision: 1 });
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('先发布 v1', r.status === 201);
  const replSrt = '2\n00:00:00,500 --> 00:00:01,500\n导入替换草稿';
  p = await srtPreview(pv.id, replSrt);
  r = await srtImport(pv.id, replSrt, 'replace', p.json.token);
  check('替换草稿成功', r.status === 201 && r.json.segments.length === 1);
  const pubSrt = await (await fetch(`${BASE}/videos/${pv.id}/srt?version=published`)).text();
  check('已发布 SRT 保持原样', /定稿/.test(pubSrt) && !/导入替换草稿/.test(pubSrt));
  const draftSrt = await (await fetch(`${BASE}/videos/${pv.id}/srt?version=draft`)).text();
  check('草稿 SRT 为导入内容', /导入替换草稿/.test(draftSrt));
  // 替换后无法直接发布（导入片段待审）
  r = await req('POST', `/videos/${pv.id}/publish`, {});
  check('待审导入片段阻止发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));

  // 无文件
  {
    const fd = new FormData();
    const res = await fetch(`${BASE}/videos/${pv.id}/srt/preview`, { method: 'POST', body: fd });
    const json = await res.json();
    check('缺少 SRT 字段 -> 422', res.status === 422 && json.error.code === 'missing_srt');
  }

  // 不存在视频
  p = await srtPreview(999999, '1\n00:00:01,000 --> 00:00:02,000\nx');
  check('未知视频预览 -> 404', p.status === 404);
}

async function restoreTests() {
  console.log('11. 历史版本区间恢复：预览与边界规则');
  const rv = await uploadVideo('区间恢复', 10000, 80);
  const addSeg = async (start, end, text) =>
    (await req('POST', `/videos/${rv.id}/segments`, { start_ms: start, end_ms: end, text })).json.segment;
  const reviewSeg = (vid, seg) =>
    req('POST', `/videos/${vid}/segments/${seg.id}/review`, { reviewed: true, revision: seg.revision });
  const getSegs = async (vid) => (await req('GET', `/videos/${vid}`)).json.segments;

  // v1：甲(1000-2000) 乙(3000-4000) 丙(5000-6000)，全部已审
  const A = await addSeg(1000, 2000, '甲');
  let B = await addSeg(3000, 4000, '乙');
  const C = await addSeg(5000, 6000, '丙');
  for (const s of [A, B, C]) await reviewSeg(rv.id, s);
  let r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('发布 v1', r.status === 201 && r.json.publication.version === 1);

  // 演进出 v2：改乙、删丙、新增丁(6500-7000) 戊(8000-9000)
  B = (await getSegs(rv.id)).find((x) => x.id === B.id);
  await req('PUT', `/videos/${rv.id}/segments/${B.id}`, { start_ms: 3000, end_ms: 4000, text: '乙改', revision: B.revision });
  const cNow = (await getSegs(rv.id)).find((x) => x.id === C.id);
  await req('DELETE', `/videos/${rv.id}/segments/${C.id}`, { revision: cNow.revision });
  await addSeg(6500, 7000, '丁');
  await addSeg(8000, 9000, '戊');
  for (const s of (await getSegs(rv.id)).filter((x) => !x.reviewed)) await reviewSeg(rv.id, s);
  r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('发布 v2', r.status === 201 && r.json.publication.version === 2);

  // 合法预览：区间 [2000,5000]，边界与两侧片段端点相接（不穿过）
  let p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 5000 });
  check('恢复预览 200', p.status === 200, JSON.stringify(p.json));
  eq('预览待恢复 1 段（来自 v1）', p.json.to_restore.map((e) => [e.start_ms, e.end_ms, e.text]), [[3000, 4000, '乙']]);
  eq('预览待移除 1 段（当前草稿）', p.json.to_remove.map((s) => [s.id, s.text]), [[B.id, '乙改']]);
  check('预览返回确认令牌', typeof p.json.token === 'string' && p.json.token.length > 10);
  const goodToken = p.json.token;

  // 边界穿过任一侧片段 -> 422 并指出片段与时间
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 3500 });
  check('终点穿过草稿片段 -> 422', p.status === 422 && p.json.error.code === 'range_crosses_segment', JSON.stringify(p.json));
  check('指出草稿片段与时间', p.json.error.crossings.some((c) =>
    c.side === 'draft' && c.segment_id === B.id && c.boundary === 'end' && c.at === 3500), JSON.stringify(p.json.error));
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 5500 });
  check('终点穿过发布快照片段 -> 422', p.status === 422 && p.json.error.code === 'range_crosses_segment');
  check('指出快照条目与时间', p.json.error.crossings.some((c) =>
    c.side === 'published' && c.at === 5500 && /5000–6000/.test(c.message)), JSON.stringify(p.json.error));
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 1500, end_ms: 5000 });
  check('起点穿过草稿片段 -> 422', p.status === 422 && p.json.error.crossings.some((c) =>
    c.boundary === 'start' && c.at === 1500 && c.segment_id === A.id), JSON.stringify(p.json.error));

  // 区间与版本参数校验
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 5000, end_ms: 5000 });
  check('起点等于终点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 6000, end_ms: 5000 });
  check('起点晚于终点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: -1, end_ms: 5000 });
  check('负起点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 10001 });
  check('终点越过视频时长 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000.5, end_ms: 5000 });
  check('非整数区间 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000 });
  check('缺少区间端点 -> 422', p.status === 422 && p.json.error.code === 'invalid_range');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 99, start_ms: 2000, end_ms: 5000 });
  check('版本不存在 -> 404', p.status === 404 && p.json.error.code === 'version_not_found');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 'x', start_ms: 2000, end_ms: 5000 });
  check('非法版本号 -> 422', p.status === 422 && p.json.error.code === 'invalid_version');
  p = await req('POST', '/videos/999999/restore/preview', { version: 1, start_ms: 0, end_ms: 100 });
  check('未知视频恢复预览 -> 404', p.status === 404);

  console.log('12. 区间恢复确认：令牌、参数一致性与预览后草稿变化');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000 });
  check('无令牌确认 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: 'garbage.token' });
  check('坏令牌 -> 409 preview_required', r.status === 409 && r.json.error.code === 'preview_required');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 2, start_ms: 2000, end_ms: 5000, token: goodToken });
  check('版本与预览不一致 -> 422', r.status === 422 && r.json.error.code === 'restore_params_changed');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5001, token: goodToken });
  check('区间与预览不一致 -> 422', r.status === 422 && r.json.error.code === 'restore_params_changed');

  // 预览后新增片段 -> 确认拒绝且不写入
  const ghost = await addSeg(9000, 9500, '他人新增');
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: goodToken });
  check('预览后草稿新增 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed', JSON.stringify(r.json));
  check('冲突返回当前片段列表', Array.isArray(r.json.error.current_segments) && r.json.error.current_segments.length === 5);
  await req('DELETE', `/videos/${rv.id}/segments/${ghost.id}`, { revision: 1 });

  // 预览后审校状态变化 -> 同样拒绝
  let aNow = (await getSegs(rv.id)).find((x) => x.id === A.id);
  await req('POST', `/videos/${rv.id}/segments/${A.id}/review`, { reviewed: false, revision: aNow.revision });
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: goodToken });
  check('预览后审校变化 -> 409 draft_changed', r.status === 409 && r.json.error.code === 'draft_changed');
  aNow = (await getSegs(rv.id)).find((x) => x.id === A.id);
  await req('POST', `/videos/${rv.id}/segments/${A.id}/review`, { reviewed: true, revision: aNow.revision });
  eq('拒绝期间草稿未被写入', (await getSegs(rv.id)).map((s) => s.text), ['甲', '乙改', '丁', '戊']);

  // 空区间（两侧均无片段）：合法且零变更
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 6000, end_ms: 6500 });
  check('空区间预览 200 且清单为空', p.status === 200 && p.json.to_restore.length === 0 && p.json.to_remove.length === 0,
    JSON.stringify(p.json));
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 6000, end_ms: 6500, token: p.json.token });
  check('空区间确认 201 零变更', r.status === 201 && r.json.removed_count === 0 && r.json.restored_count === 0, JSON.stringify(r.json));
  eq('空恢复后草稿不变', r.json.segments.map((s) => s.text), ['甲', '乙改', '丁', '戊']);

  console.log('13. 区间恢复确认：成功恢复与不变量');
  const before = await getSegs(rv.id);
  const aBefore = before.find((x) => x.id === A.id);
  const dBefore = before.find((x) => x.text === '丁');
  p = await req('POST', `/videos/${rv.id}/restore/preview`, { version: 1, start_ms: 2000, end_ms: 5000 });
  r = await req('POST', `/videos/${rv.id}/restore/confirm`, { version: 1, start_ms: 2000, end_ms: 5000, token: p.json.token });
  check('确认恢复 201', r.status === 201, JSON.stringify(r.json));
  eq('移除 1 段', r.json.removed_count, 1);
  eq('恢复 1 段', r.json.restored_count, 1);
  eq('被移除的是区间内草稿片段', r.json.removed[0].id, B.id);
  const restored = r.json.restored[0];
  check('恢复片段是新片段（新 id）', restored.id !== B.id);
  eq('恢复片段修订号从 1 开始', restored.revision, 1);
  eq('恢复片段为待审', restored.reviewed, false);
  eq('恢复片段内容来自 v1', [restored.start_ms, restored.end_ms, restored.text], [3000, 4000, '乙']);
  eq('恢复后共 4 段', r.json.segments.length, 4);
  const aAfter = r.json.segments.find((x) => x.id === A.id);
  eq('区间外片段修订号不变', aAfter.revision, aBefore.revision);
  eq('区间外片段审校状态不变', aAfter.reviewed, aBefore.reviewed);
  const dAfter = r.json.segments.find((x) => x.text === '丁');
  eq('区间外片段 id 与修订号不变', [dAfter.id, dAfter.revision], [dBefore.id, dBefore.revision]);

  const pubs = (await req('GET', `/videos/${rv.id}/publications`)).json.publications;
  eq('历史发布版本不变', pubs.map((x) => x.version), [2, 1]);
  const v1Srt = await (await fetch(`${BASE}/videos/${rv.id}/srt?version=1`)).text();
  check('v1 SRT 导出语义不变', /甲/.test(v1Srt) && /乙/.test(v1Srt) && /丙/.test(v1Srt));
  const draftSrt = await (await fetch(`${BASE}/videos/${rv.id}/srt?version=draft`)).text();
  check('草稿 SRT 反映恢复结果', /乙/.test(draftSrt) && !/乙改/.test(draftSrt) && !/丙/.test(draftSrt));

  // 发布门禁沿用：恢复片段待审 -> 不能发布；审校后可发布
  r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('恢复片段待审阻止发布 -> 422', r.status === 422 && /未通过审校/.test(r.json.error.message));
  const restoredNow = (await getSegs(rv.id)).find((x) => x.id === restored.id);
  await reviewSeg(rv.id, restoredNow);
  r = await req('POST', `/videos/${rv.id}/publish`, {});
  check('恢复片段审校后可发布 v3', r.status === 201 && r.json.publication.version === 3, JSON.stringify(r.json));

  console.log('14. 区间恢复：版本缺失与替换后时间线不合法（零写入）');
  const rv2 = await uploadVideo('恢复保护', 5000, 48);
  const one = (await req('POST', `/videos/${rv2.id}/segments`, { start_ms: 1000, end_ms: 2000, text: '一' })).json.segment;
  await reviewSeg(rv2.id, one);
  r = await req('POST', `/videos/${rv2.id}/publish`, {});
  check('第二个视频发布 v1', r.status === 201);
  let p2 = await req('POST', `/videos/${rv2.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 2000 });
  check('替换前预览 200', p2.status === 200, JSON.stringify(p2.json));
  const rv2Token = p2.json.token;

  // 直接改库模拟损坏快照：区间内条目互相重叠 -> 替换后时间线不合法
  const Database = require('better-sqlite3');
  const db = new Database(path.join(tmpDir, 'test.db'));
  db.prepare('UPDATE publications SET snapshot = ? WHERE video_id = ? AND version = 1')
    .run(JSON.stringify([
      { start_ms: 500, end_ms: 1500, text: 'x' },
      { start_ms: 1000, end_ms: 1800, text: 'y' },
    ]), rv2.id);
  r = await req('POST', `/videos/${rv2.id}/restore/confirm`, { version: 1, start_ms: 0, end_ms: 2000, token: rv2Token });
  check('替换后时间线不合法 -> 422', r.status === 422 && r.json.error.code === 'invalid_timeline', JSON.stringify(r.json));
  p2 = await req('POST', `/videos/${rv2.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 2000 });
  check('预览同样拒绝非法替换', p2.status === 422 && p2.json.error.code === 'invalid_timeline');
  eq('非法替换零写入', (await getSegs(rv2.id)).map((s) => [s.start_ms, s.end_ms, s.text]), [[1000, 2000, '一']]);

  // 删除发布版本 -> 预览与确认均 404，且不写入
  db.prepare('DELETE FROM publications WHERE video_id = ? AND version = 1').run(rv2.id);
  db.close();
  p2 = await req('POST', `/videos/${rv2.id}/restore/preview`, { version: 1, start_ms: 0, end_ms: 2000 });
  check('版本被删后预览 -> 404', p2.status === 404 && p2.json.error.code === 'version_not_found');
  r = await req('POST', `/videos/${rv2.id}/restore/confirm`, { version: 1, start_ms: 0, end_ms: 2000, token: rv2Token });
  check('版本被删后确认 -> 404 且不写入', r.status === 404 && r.json.error.code === 'version_not_found');
  eq('版本缺失零写入', (await getSegs(rv2.id)).length, 1);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(tmpDir, 'test.db'),
    UPLOAD_DIR: path.join(tmpDir, 'videos'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/videos`);
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器启动超时：\n' + serverOut);
}

waitForServer()
  .then(main)
  .then(() => { server.kill(); fs.rmSync(tmpDir, { recursive: true, force: true }); })
  .catch((e) => {
    console.error('测试运行失败:', e);
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
