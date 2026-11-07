#!/usr/bin/env node
/**
 * repair-encoding.mjs — 检测并修复「UTF-8 文本曾被按 GBK 解码、又以 UTF-8 存回」的乱码。
 *
 * 背景：编辑器/终端用 CP936 打开 UTF-8 文件再保存，就会出现
 *   鎶?WorkBuddy 渚у彲鐢?   行尾 '?'、\n 被吞、多字节序列被拆碎。
 * 被吞掉的部分是「无法还原」的位，本脚本只负责把整文件按 GBK 解回，
 * 并给出「剩余可疑位置」清单，方便人工补字。
 *
 * 用法：
 *   node scripts/repair-encoding.mjs --scan  <files...>   # 只报告，不改文件
 *   node scripts/repair-encoding.mjs --fix   <files...>   # 就地修复（会先备份 .bak-encoding）
 *
 * 判定：UTF-8 汉字数 > 0 且 GBK 汉字数 >= UTF-8 汉字数 × 1.3 → 视为乱码文件。
 *      （正常 UTF-8 中文按 GBK 解，要么大量 '?'，要么汉字数明显更少。）
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const HAN = /[\u3400-\u9fff]/gu;
const han = (s) => (s.match(HAN) ?? []).length;

/** 用 PowerShell/.NET 的 CP936 解码取汉字数（Node 没有内置 GBK 解码器） */
function gbkDecode(file) {
  if (process.platform !== 'win32') return null;
  const ps = [
    `$b=[IO.File]::ReadAllBytes('${file.replace(/'/gu, "''")}')`,
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8`,
    `[Text.Encoding]::GetEncoding(936).GetString($b)`,
  ].join('; ');
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) return null;
  return out.stdout.toString('utf8');
}

const mode = process.argv[2];
const files = process.argv.slice(3);
if (!['--scan', '--fix'].includes(mode) || files.length === 0) {
  console.error('usage: node repair-encoding.mjs --scan|--fix <files...>');
  process.exit(2);
}

let damaged = 0;
for (const file of files) {
  const buf = readFileSync(file);
  const utf8 = buf.toString('utf8');
  const gbk = gbkDecode(file);
  const hU = han(utf8);
  const hG = gbk === null ? hU : han(gbk);
  const looksGarbled = hU > 0 && hG >= hU * 1.3;

  if (!looksGarbled) {
    console.log(`  OK      ${file}   (han utf8=${hU} gbk=${hG})`);
    continue;
  }

  damaged += 1;
  const suspicious = (gbk.match(/.[?]/gu) ?? []).length;
  console.log(`  GARBLED ${file}   (han utf8=${hU} gbk=${hG}, 可疑被吞处≈${suspicious})`);

  if (mode === '--fix' && gbk !== null) {
    copyFileSync(file, `${file}.bak-encoding`);
    writeFileSync(file, gbk, 'utf8');
    console.log(`          → 已写入修复结果（备份 ${file}.bak-encoding），请人工核对 ${suspicious} 处被吞字符`);
  }
}

console.log(`\n${files.length} file(s): ${damaged} garbled`);
process.exit(damaged > 0 ? 1 : 0);
