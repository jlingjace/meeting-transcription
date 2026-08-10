const btn = document.getElementById('grant');
const status = document.getElementById('status');

function showOk(msg)  { status.className = 'status ok';  status.textContent = msg; }
function showErr(msg) { status.className = 'status err'; status.textContent = msg; }

async function checkExisting() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state === 'granted') {
      showOk('✓ 已授权麦克风。这个页面可以关闭了。');
      btn.disabled = true;
      btn.textContent = '已授权';
    }
  } catch {}
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // permission persists; release immediately
    showOk('✓ 授权成功！可以关闭这个页面，回到 Google Meet 点击扩展图标开始录音。');
    btn.textContent = '已授权';
  } catch (e) {
    showErr('✗ 授权失败：' + e.message);
    btn.disabled = false;
  }
});

checkExisting();
