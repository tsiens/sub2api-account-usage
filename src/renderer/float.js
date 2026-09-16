'use strict';

const track = document.getElementById('marqueeTrack');
const shell = document.getElementById('floatShell');
let dragState;
let suppressClick = false;
let pendingDx = 0;
let pendingDy = 0;
let moveFrame = 0;
let rotationTimer;
let rotationIndex = 0;
const icons = {
  openai: 'openai', gpt: 'openai', chatgpt: 'openai', 'openai-compatible': 'openai',
  claude: 'anthropic', anthropic: 'anthropic',
  'google-gemini': 'gemini', google: 'gemini', gemini: 'gemini',
  xai: 'grok', grok: 'grok', antigravity: 'antigravity',
  kimi: 'openai', moonshot: 'openai', copilot: 'openai', github: 'openai'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function used(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function providerIcon(account) {
  const key = String(account?.platform || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return icons[key] || 'openai';
}

function renderProviderIcon(icon) {
  if (icons[icon]) return `<img class="provider-logo" src="./${icons[icon]}.svg" alt="">`;
  return '<img class="provider-logo" src="./openai.svg" alt="">';
}

function render(state) {
  const accounts = state.accounts || [];
  const values = accounts.length
    ? accounts.map((item) => {
      const five = used(item.usage?.five_hour?.utilization);
      const seven = used(item.usage?.seven_day?.utilization);
      return {
        icon: providerIcon(item.account),
        five: `${five}%`,
        seven: `${seven}%`
      };
    })
    : [{ icon: 'openai', five: '--%', seven: '--%' }];
  clearInterval(rotationTimer);
  rotationIndex = 0;
  track.style.transition = 'none';
  track.style.transform = 'translateY(0)';
  const slides = values.length > 1 ? [...values, values[0]] : values;
  track.innerHTML = slides.map((value, index) => `<span class="marquee-item"${index === values.length ? ' aria-hidden="true"' : ''}><strong class="usage-value usage-five">${escapeHtml(value.five)}</strong><i class="provider-icon">${renderProviderIcon(value.icon)}</i><strong class="usage-value usage-seven">${escapeHtml(value.seven)}</strong></span>`).join('');
  if (values.length > 1) {
    const interval = Math.max(1000, Number(state.config?.rotationInterval) * 1000 || 5000);
    rotationTimer = setInterval(advanceAccount, interval);
  }
}

function advanceAccount() {
  rotationIndex += 1;
  track.style.transition = 'transform .42s ease';
  track.style.transform = `translateY(-${rotationIndex * 30}px)`;
  if (rotationIndex === track.children.length - 1) {
    window.setTimeout(() => {
      rotationIndex = 0;
      track.style.transition = 'none';
      track.style.transform = 'translateY(0)';
    }, 460);
  }
}

shell.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragState = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    x: event.screenX,
    y: event.screenY,
    moved: false
  };
  pendingDx = 0;
  pendingDy = 0;
  window.sub2api.beginFloatDrag();
  shell.classList.add('dragging');
  shell.setPointerCapture?.(event.pointerId);
});

// Coalesce pointer events into one window move per frame: dragging a native window is
// expensive enough that sending every raw event just queues work up behind the cursor.
function flushMove() {
  moveFrame = 0;
  if (!pendingDx && !pendingDy) return;
  const dx = pendingDx;
  const dy = pendingDy;
  pendingDx = 0;
  pendingDy = 0;
  void window.sub2api.moveFloat({ dx, dy }).catch(() => {});
}

shell.addEventListener('pointermove', (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId || !event.buttons) return;
  pendingDx += event.screenX - dragState.x;
  pendingDy += event.screenY - dragState.y;
  dragState.x = event.screenX;
  dragState.y = event.screenY;
  if (!dragState.moved && (Math.abs(event.screenX - dragState.startX) > 3 || Math.abs(event.screenY - dragState.startY) > 3)) {
    dragState.moved = true;
  }
  if (!moveFrame) moveFrame = window.requestAnimationFrame(flushMove);
  event.preventDefault();
});

function finishDrag(event) {
  if (!dragState || (event && event.pointerId !== dragState.pointerId)) return;
  if (moveFrame) window.cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  const dx = pendingDx;
  const dy = pendingDy;
  pendingDx = 0;
  pendingDy = 0;
  const moved = dragState.moved;
  suppressClick = moved;
  shell.classList.remove('dragging');
  shell.releasePointerCapture?.(dragState.pointerId);
  dragState = undefined;
  if (!moved) return;
  // Apply the last partial movement first, then let the backend snap and persist the
  // final position, so releasing the bar never jumps back by one frame.
  void (async () => {
    try {
      if (dx || dy) await window.sub2api.moveFloat({ dx, dy });
      await window.sub2api.endFloatDrag();
    } catch { /* Dragging must never surface an error to the user. */ }
  })();
}

shell.addEventListener('pointerup', finishDrag);
shell.addEventListener('pointercancel', finishDrag);
shell.addEventListener('lostpointercapture', finishDrag);
shell.addEventListener('click', () => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  window.sub2api.openPanel();
});
window.sub2api.onState(render);
window.sub2api.onFloatColor((color) => {
  shell.classList.toggle('theme-light', color === 'light');
  shell.classList.toggle('theme-dark', color !== 'light');
});
window.sub2api.getState().then(render);
