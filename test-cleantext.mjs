// Fixtures are the actual lines produced from a real meeting recording.
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('./offscreen.js', import.meta.url), 'utf8');
const fn = src.match(/function cleanText\(raw\)[\s\S]*?\n}/)[0];
const ctx = vm.createContext({});
vm.runInContext(fn + '\ncleanText', ctx);
const cleanText = vm.runInContext('cleanText', ctx);

let fail = 0;
const t = (label, input, expect) => {
  const got = cleanText(input);
  const ok = typeof expect === 'function' ? expect(got) : got === expect;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}\n     "${input}"\n     → "${got}"${ok ? '' : `  (期望 ${expect})`}`);
  if (!ok) fail++;
};

console.log('\n── 真实会议里出现的重复吐字 ──');
t('保住尾部有效内容',
  '你你你你你你你你你你你你你是你你是你是是你你你你试你是不是该换电脑了？',
  (g) => g.includes('是不是该换电脑了') && g.length < 25);
t('刷刷刷 → 保留句子',
  '啊刷刷刷刷刷刷刷刷刷上来是吗。',
  (g) => g.includes('上来是吗') && !/刷刷/.test(g));
t('数字重复',
  'five five five55,5,5,5,5,5,,,,,,,,,, space那块怎么去写做的那个事情。',
  (g) => g.includes('那块怎么去写做的那个事情') && g.length < 45);
t('对对对对对对 → 收敛',
  '对对对对对对，我觉得这样的话',
  (g) => !/对对对/.test(g) && g.includes('我觉得这样的话'));

console.log('\n── 噪声段应被丢弃 ──');
t('纯标点', '.', '');
t('单字 + 标点', '嗯.', '');
t('单个汉字噪声', '屌。', '');
t('单个汉字噪声2', '圆。', '');
t('日语幻觉（用户只说中英）', 'ささささささささささ。', '');
t('日语幻觉2', 'うん。', '');
t('空字符串', '   ', '');

console.log('\n── 正常内容必须原样保留 ──');
t('中文整句',
  '他们在加拿大有一个办公室在蒙特利尔。',
  '他们在加拿大有一个办公室在蒙特利尔。');
t('中英混合',
  '我今天问的那另一家不是说不收那个model吗？',
  '我今天问的那另一家不是说不收那个model吗？');
t('英文整句',
  'The tribal chieftain called for the boy and presented him with 50 pieces of code.',
  'The tribal chieftain called for the boy and presented him with 50 pieces of code.');
t('短但有效', '你好像又卡了。', '你好像又卡了。');
t('正常叠词不该被毁', '看看这个', '看看这个');

console.log(fail === 0 ? '\n=== ALL PASS ===' : `\n=== ${fail} FAILED ===`);
process.exit(fail ? 1 : 0);
