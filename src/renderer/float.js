'use strict';

const track = document.getElementById('marqueeTrack');
const shell = document.getElementById('floatShell');
let dragState;
let suppressClick = false;
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
  return icons[key] || '•';
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
        usage: `${five}%·${seven}%`
      };
    })
    : [{ icon: '•', usage: '--%·--%' }];
  clearInterval(rotationTimer);
  rotationIndex = 0;
  track.style.transition = 'none';
  track.style.transform = 'translateY(0)';
  const slides = values.length > 1 ? [...values, values[0]] : values;
  track.innerHTML = slides.map((value, index) => `<span class="marquee-item"${index === values.length ? ' aria-hidden="true"' : ''}><i class="provider-icon">${renderProviderIcon(value.icon)}</i><strong class="usage-values">${escapeHtml(value.usage)}</strong></span>`).join('');
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
  shell.classList.add('dragging');
  shell.setPointerCapture?.(event.pointerId);
});

shell.addEventListener('pointermove', (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId || !event.buttons) return;
  const dx = event.screenX - dragState.x;
  const dy = event.screenY - dragState.y;
  if (!dx && !dy) return;
  if (Math.abs(event.screenX - dragState.startX) > 3 || Math.abs(event.screenY - dragState.startY) > 3) {
    dragState.moved = true;
  }
  dragState.x = event.screenX;
  dragState.y = event.screenY;
  window.sub2api.moveFloat({ dx, dy });
  event.preventDefault();
});

function finishDrag(event) {
  if (!dragState || (event && event.pointerId !== dragState.pointerId)) return;
  suppressClick = dragState.moved;
  shell.classList.remove('dragging');
  shell.releasePointerCapture?.(dragState.pointerId);
  dragState = undefined;
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
