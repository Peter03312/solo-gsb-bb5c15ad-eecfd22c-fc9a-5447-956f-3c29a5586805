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
