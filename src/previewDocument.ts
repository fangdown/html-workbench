function prepareScene(channel: string) {
  let scene: Element | null = null;
  let scheduled = false;
  const style = document.createElement('style');
  style.textContent = '[data-workbench-hidden],[data-workbench-hidden] *{visibility:hidden!important;pointer-events:none!important}html{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}';
  document.head.appendChild(style);

  function visibleArea(element: Element) {
    const box = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    if (box.width < 80 || box.height < 60 || css.display === 'none' || css.visibility === 'hidden') return 0;
    return box.width * box.height;
  }

  function findScene() {
    const explicit = document.querySelector('[data-preview-scene]');
    if (explicit && visibleArea(explicit)) return explicit;
    const graphics = Array.from(document.querySelectorAll('svg,canvas')).filter(element => !element.parentElement?.closest('svg'));
    const candidates = graphics.some(element => visibleArea(element) > 0)
      ? graphics
      : Array.from(document.querySelectorAll('#scene,.scene,#stage,.stage,#animation,.animation,main'));
    return candidates.filter(element => visibleArea(element) > 0).sort((a, b) => visibleArea(b) - visibleArea(a))[0] ?? null;
  }

  function report() {
    scheduled = false;
    if (!scene || !scene.isConnected) scene = findScene();
    if (!scene) return;
    let branch: Element = scene;
    while (branch.parentElement && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) {
          sibling.setAttribute('data-workbench-hidden', '');
        }
      }
      branch = branch.parentElement;
    }
    for (const control of document.querySelectorAll('[data-preview-ui],button,input,select,textarea,progress,[role="slider"],[role="progressbar"],.controls,.toolbar,.hud,.progress,.timeline')) {
      if (control !== scene && !control.contains(scene)) control.setAttribute('data-workbench-hidden', '');
    }
    const box = scene.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      window.parent.postMessage({ type: 'workbench:scene', channel, x: box.left, y: box.top, width: box.width, height: box.height }, '*');
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(report);
  }

  function mount() {
    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    if (scene) observer.observe(scene);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('load', schedule);
    document.fonts.ready.then(schedule);
    setTimeout(schedule, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

export function createPreviewDocument(html: string, channel: string) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
  document.head.prepend(policy);
  const script = document.createElement('script');
  script.textContent = `(${prepareScene.toString()})(${JSON.stringify(channel)});`;
  document.body.appendChild(script);
  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}
