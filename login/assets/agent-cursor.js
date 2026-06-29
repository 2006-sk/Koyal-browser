/**
 * Injects a highly visible agent cursor overlay into the page.
 */
(function () {
  if (window.__qaAgentCursor) return;
  window.__qaAgentCursor = true;

  var style = document.createElement('style');
  style.textContent =
    '#__qa-agent-cursor{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;transform:translate(-100px,-100px);transition:transform 120ms ease-out}' +
    '#__qa-agent-cursor .ring{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border:3px solid #ff3b30;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 0 12px rgba(255,59,48,.6);animation:qa-cursor-pulse 1.2s ease-in-out infinite}' +
    '#__qa-agent-cursor .dot{position:absolute;left:-4px;top:-4px;width:8px;height:8px;background:#ff3b30;border-radius:50%;box-shadow:0 0 0 2px #fff}' +
    '#__qa-agent-cursor .label{position:absolute;left:14px;top:-28px;background:#ff3b30;color:#fff;font:600 11px/1.2 ui-sans-serif,system-ui,sans-serif;padding:2px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
    '@keyframes qa-cursor-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.15);opacity:.85}}';
  document.documentElement.appendChild(style);

  var cursor = document.createElement('div');
  cursor.id = '__qa-agent-cursor';
  cursor.innerHTML =
    '<div class="ring"></div><div class="dot"></div><div class="label">QA Agent</div>';
  document.documentElement.appendChild(cursor);

  var x = window.innerWidth / 2;
  var y = window.innerHeight / 2;

  function update() {
    cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  document.addEventListener(
    'mousemove',
    function (event) {
      x = event.clientX;
      y = event.clientY;
      update();
    },
    { passive: true },
  );

  window.addEventListener('qa-cursor-move', function (event) {
    x = event.detail.x;
    y = event.detail.y;
    update();
  });

  update();
})();
