'use strict';

/**
 * 端到端验证：连续改版时提示锚点随自动绑定同步刷新。
 * 场景：第1版 A/X/B -> 第2版 A/X/C（自动绑定）-> 第3版 D/X/C（修复前误变待确认）。
 * 另覆盖：待确认保留原锚点与候选行、恢复预览只读、恢复提交校验版本号与提示凭据。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  // 1. 建剧本 v1：A/X/B，X 上挂提示
  const created = await api('POST', '/api/scripts', { title: '连续改版测试', content: 'A\nX\nB' });
  const sid = created.data.id;
  let detail = await api('GET', `/api/scripts/${sid}`);
  check('v1 创建，当前版本=1', detail.data.current_version === 1);

  const cueRes = await api('POST', `/api/scripts/${sid}/cues`, {
    type: 'light',
    label: '灯光渐亮',
    lineNo: 2,
  });
  const cueId = cueRes.data.id;
  detail = await api('GET', `/api/scripts/${sid}`);
  let cue = detail.data.cues.find((c) => c.id === cueId);
  check('v1 提示已绑定，锚点 X，上下文 A/B',
    cue.anchor_status === 'bound' && cue.anchor_text === 'X' &&
    JSON.stringify(cue.context_before) === '["A"]' && JSON.stringify(cue.context_after) === '["B"]',
    cue);

  // 2. 保存 v2：A/X/C —— 应自动绑定，且锚点/上下文快照同步刷新为 A/C
  let save = await api('PUT', `/api/scripts/${sid}/content`, { content: 'A\nX\nC' });
  check('v2 保存：1 条自动绑定、0 待确认', save.data.stats.bound === 1 && save.data.stats.pending === 0, save.data);
  detail = await api('GET', `/api/scripts/${sid}`);
  cue = detail.data.cues.find((c) => c.id === cueId);
  check('v2 快照已刷新：anchor_text=X，上下文 A/C，行号 2，version=2',
    cue.anchor_status === 'bound' && cue.line_no === 2 && cue.anchor_text === 'X' &&
    JSON.stringify(cue.context_before) === '["A"]' && JSON.stringify(cue.context_after) === '["C"]' &&
    cue.version === 2,
    cue);

  // 3. 保存 v3：D/X/C —— 修复的关键：依据最近一次确认的绑定（A/C）迁移，after C 吻合 -> 自动绑定
  save = await api('PUT', `/api/scripts/${sid}/content`, { content: 'D\nX\nC' });
  check('v3 保存：仍自动绑定（不再误变待确认）', save.data.stats.bound === 1 && save.data.stats.pending === 0, save.data);
  detail = await api('GET', `/api/scripts/${sid}`);
  cue = detail.data.cues.find((c) => c.id === cueId);
  check('v3 快照刷新为 D/C，行号 2，version=3',
    cue.anchor_status === 'bound' && cue.line_no === 2 &&
    JSON.stringify(cue.context_before) === '["D"]' && JSON.stringify(cue.context_after) === '["C"]' &&
    cue.version === 3,
    cue);

  // 4. 保存 v4：D/X/E —— 连续第 3 次改版，before D 吻合 -> 自动绑定
  save = await api('PUT', `/api/scripts/${sid}/content`, { content: 'D\nX\nE' });
  check('v4 保存：仍自动绑定', save.data.stats.bound === 1 && save.data.stats.pending === 0, save.data);

  // 5. 保存 v5：D/X/E/D/X/E —— 两处 X 上下文打平，无法唯一定位 -> 待确认，保留原锚点与候选行
  save = await api('PUT', `/api/scripts/${sid}/content`, { content: 'D\nX\nE\nD\nX\nE' });
  check('v5 保存：1 条待确认', save.data.stats.pending === 1, save.data);
  detail = await api('GET', `/api/scripts/${sid}`);
  cue = detail.data.cues.find((c) => c.id === cueId);
  check('v5 待确认：保留原锚点 X 与候选行（2 个候选）',
    cue.anchor_status === 'pending' && cue.anchor_text === 'X' &&
    cue.issue && cue.issue.type === 'duplicate' && cue.issue.candidates.length === 2,
    cue.issue);

  // 6. 人工重绑到第 5 行（第二处 X）—— 快照以当前版本重建
  const rebind = await api('POST', `/api/cues/${cueId}/rebind`, { lineNo: 5 });
  check('人工重绑成功', rebind.status === 200);
  detail = await api('GET', `/api/scripts/${sid}`);
  cue = detail.data.cues.find((c) => c.id === cueId);
  check('重绑后：bound，行号 5，上下文前 D/E、后 E（各取 2 行非空）',
    cue.anchor_status === 'bound' && cue.line_no === 5 &&
    JSON.stringify(cue.context_before) === '["D","E"]' && JSON.stringify(cue.context_after) === '["E"]',
    cue);

  // 7. 恢复预览（只读）：目标 v3 = D/X/C。当前快照 D/E，v3 中 X 唯一、before D 吻合 -> 预览自动绑定
  const before = await api('GET', `/api/scripts/${sid}`);
  const preview = await api('GET', `/api/scripts/${sid}/versions/3/restore-preview`);
  check('预览返回版本号与提示凭据', preview.data.current_version === 5 && /^[a-f0-9]{64}$/.test(preview.data.cue_token), preview.data);
  check('预览：1 条将自动绑定、0 待确认', preview.data.bound === 1 && preview.data.pending === 0, preview.data);
  const after = await api('GET', `/api/scripts/${sid}`);
  check('预览只读：剧本版本与提示均未变化',
    JSON.stringify(before.data) === JSON.stringify(after.data));

  // 8. 恢复提交：先验证凭据校验（错误凭据 -> 409，不生成新版本）
  let bad = await api('POST', `/api/scripts/${sid}/versions/3/restore`, {
    expectedCurrentVersion: 5,
    expectedCueToken: '0'.repeat(64),
  });
  check('错误提示凭据 -> 409', bad.status === 409, bad);
  bad = await api('POST', `/api/scripts/${sid}/versions/3/restore`, {
    expectedCurrentVersion: 4,
    expectedCueToken: preview.data.cue_token,
  });
  check('错误版本号 -> 409', bad.status === 409, bad);
  detail = await api('GET', `/api/scripts/${sid}`);
  check('409 后版本仍为 5（未生成新版本）', detail.data.current_version === 5);

  // 9. 正确凭据提交恢复：v3 正文另存为 v6，提示自动绑定且快照刷新为 D/C
  const restore = await api('POST', `/api/scripts/${sid}/versions/3/restore`, {
    expectedCurrentVersion: preview.data.current_version,
    expectedCueToken: preview.data.cue_token,
  });
  check('恢复成功：restored_from=3，新版本=6，1 条自动绑定',
    restore.status === 200 && restore.data.restored_from === 3 && restore.data.version === 6 &&
    restore.data.stats.bound === 1 && restore.data.stats.pending === 0,
    restore.data);
  detail = await api('GET', `/api/scripts/${sid}`);
  cue = detail.data.cues.find((c) => c.id === cueId);
  check('恢复后：正文为 v3 内容，提示 bound 于第 2 行，快照刷新为 D/C',
    detail.data.content === 'D\nX\nC' && cue.anchor_status === 'bound' && cue.line_no === 2 &&
    JSON.stringify(cue.context_before) === '["D"]' && JSON.stringify(cue.context_after) === '["C"]',
    cue);

  // 10. 恢复后再连续改版：D/X/C -> D/X/F -> G/X/F 都应自动绑定（迁移以最近一次确认绑定为依据）
  save = await api('PUT', `/api/scripts/${sid}/content`, { content: 'D\nX\nF' });
  check('恢复后改版 v7：自动绑定', save.data.stats.bound === 1 && save.data.stats.pending === 0, save.data);
  save = await api('PUT', `/api/scripts/${sid}/content`, { content: 'G\nX\nF' });
  check('恢复后改版 v8：自动绑定', save.data.stats.bound === 1 && save.data.stats.pending === 0, save.data);

  // 11. 历史快照不可变：v1 内容仍是 A/X/B
  const v1 = await api('GET', `/api/scripts/${sid}/versions/1`);
  check('历史版本 v1 快照不可变', v1.data.content === 'A\nX\nB');

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, ASSET_DIR: path.join(tmpDir, 'assets') },
  cwd: path.join(__dirname),
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', async (buf) => {
  if (!buf.toString().includes('已启动')) return;
  try {
    await main();
  } catch (err) {
    console.error('测试异常:', err);
    process.exitCode = 1;
  } finally {
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
  }
});
setTimeout(() => {
  console.error('测试超时');
  server.kill();
  process.exit(1);
}, 30000);
