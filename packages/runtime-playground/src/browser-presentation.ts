export interface BrowserPresentation {
  pointer?: { enabled?: boolean; style?: "arrow" | "dot" | "touch"; size?: number; color?: string }
  clickFeedback?: "ripple" | "pulse" | false
  motion?: { moveDurationMs?: number; easing?: "linear" | "ease-in-out" }
  typing?: { delayMs?: number; applyToFill?: boolean }
}

export function browserPresentationInitScript(presentation: BrowserPresentation): string {
  const config = JSON.stringify(presentation)
  return `(() => {
    const config = ${config};
    const install = () => {
      if (document.querySelector('browser-presentation-root')) return;
      const host = document.createElement('browser-presentation-root');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      const shadow = host.attachShadow({mode:'closed'});
      const cursor = document.createElement('div');
      const pointer = config.pointer || {};
      const size = Number(pointer.size) || 20;
      cursor.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;transform:translate(-2px,-2px);display:' + (pointer.enabled === false ? 'none' : 'block') + ';';
      if (pointer.style === 'dot') cursor.style.cssText += 'width:'+size+'px;height:'+size+'px;border-radius:50%;background:'+(pointer.color||'#e11d48')+';';
      else if (pointer.style === 'touch') cursor.style.cssText += 'width:'+size+'px;height:'+size+'px;border:2px solid '+(pointer.color||'#e11d48')+';border-radius:50%;';
      else cursor.innerHTML = '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24"><path fill="'+(pointer.color||'#111')+'" stroke="white" d="M3 2l7 19 3-7 7-3z"/></svg>';
      shadow.append(cursor);
      document.documentElement.append(host);
      window.addEventListener('mousemove', event => { cursor.style.left=event.clientX+'px'; cursor.style.top=event.clientY+'px'; }, true);
      window.addEventListener('click', event => {
        if (!config.clickFeedback) return;
        const ring=document.createElement('div'); ring.style.cssText='position:fixed;left:'+event.clientX+'px;top:'+event.clientY+'px;width:12px;height:12px;border:2px solid '+(pointer.color||'#e11d48')+';border-radius:50%;transform:translate(-50%,-50%);animation:presentation-ripple .55s ease-out forwards';
        const style=document.createElement('style'); style.textContent='@keyframes presentation-ripple{to{opacity:0;transform:translate(-50%,-50%) scale(4)}}'; shadow.append(style,ring); setTimeout(()=>ring.remove(),600);
      }, true);
    };
    if (document.documentElement) install(); else addEventListener('DOMContentLoaded', install, {once:true});
  })()`
}

export function validateBrowserPresentation(input: unknown): BrowserPresentation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("presentation-json must be an object")
  return input as BrowserPresentation
}
