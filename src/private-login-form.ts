/** Executed only in a private isolated world. Exports fixed kinds or a bound object. */
export const LOGIN_FORM = String.raw`function(origin, bind) {
  const page = globalThis, doc = document, url = location.href;
  const visible = e => e.isConnected && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const text = e => (e?.getAttribute('aria-label') || (e?.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => doc.getElementById(id)?.textContent || '').join(' ').trim() || e?.innerText || e?.value || '').trim().replace(/\s+/g,' ').toLowerCase();
  const denied = /(?:create (?:an? |your )?account|sign ?up|register|reset password|change password|new password|account recovery|place order|checkout|payment|delete account|enable two|disable two|set up|add (?:a )?(?:phone|mobile))/i;
  if (location.origin !== origin || /(?:register|signup|forgot|recover|reset|checkout|payment|settings|enroll)/i.test(location.pathname)) return 'manual';
  const headings = Array.from(doc.querySelectorAll('h1,h2')).filter(visible).map(text).join(' ').slice(0,2000);
  const candidates = [];
  const loginDestination = (value, amazonIdentifier) => {
    const destination = new URL(value);
    return destination.origin === origin && !/(?:register|signup|forgot|recover|reset|checkout|payment|settings|enroll|delete|disable|enable|change|update|purchase)/i.test(destination.pathname) &&
      (/(?:^|[\/_.-])(?:login|log-in|signin|sign-in|sessions?|authenticate|authentication|auth|authorize|verify|verification|mfa|otp|challenge)(?:$|[\/_.-])/i.test(destination.pathname) ||
        (amazonIdentifier && destination.pathname === '/ax/claim'));
  };
  for (const form of Array.from(doc.forms).slice(0,30)) {
    if (!visible(form)) continue;
    if (Array.from(form.elements).some(e => !form.contains(e) || (visible(e) && ['SELECT','TEXTAREA'].includes(e.tagName)))) continue;
    const inputs = Array.from(form.querySelectorAll('input')).filter(e => visible(e) && !e.matches(':disabled') && !e.readOnly && !['hidden','submit','button','checkbox','radio'].includes(e.type));
    if (!inputs.length || inputs.length > 3 || inputs.some(e => e.form !== form)) continue;
    const kinds = inputs.map(e => {
      const ac = e.autocomplete.toLowerCase(), hint = [e.name,e.id,e.placeholder,e.getAttribute('aria-label'),...Array.from(e.labels || []).map(text)].join(' ').toLowerCase();
      if (/new-password|confirm|repeat/.test(ac+' '+hint)) return null;
      if (ac === 'one-time-code' || /(?:\botp\b|otpcode|verification.?code|verify.?code|one.?time.?password|auth.?code|security.?code)/.test(hint)) return 'code';
      if (e.type === 'password' && (ac === 'current-password' || /password|passwd/.test(hint))) return 'password';
      if (['text','email','tel'].includes(e.type) && (ac === 'username' || ac === 'email' || /(?:email|username|user.?name|login.?id|phone|mobile)/.test(hint))) return 'username';
      return null;
    });
    if (kinds.some(k => !k) || new Set(kinds).size !== kinds.length) continue;
    const controls = Array.from(form.querySelectorAll('button,input[type=submit]')).filter(e => visible(e) && e.form === form && e.type === 'submit');
    const buttons = controls.filter(e => /^(?:sign ?in|log ?in|continue|next|verify|verify (?:code|otp)|submit|authenticate)$/.test(text(e)));
    if (buttons.length !== 1) continue;
    const button = buttons[0], label = text(button), copy = form.cloneNode(true);
    copy.querySelectorAll('a,button,input[type=submit],input[type=button],script,style').forEach(e => e.remove());
    const purpose = headings+' '+copy.textContent.slice(0,4000).toLowerCase();
    // Amazon's identifier page can say "Sign in or create account". Never accept
    // that ambiguity for a password/code screen or click a registration action.
    const amazonIdentifier = origin === 'https://www.amazon.com' && location.pathname === '/ap/signin' &&
      kinds.length === 1 && kinds[0] === 'username' && /sign ?in/.test(headings);
    if (denied.test(label) || (denied.test(purpose) && !amazonIdentifier)) continue;
    if (!/(?:sign ?in|log ?in|two.?step verification|two.?factor authentication)/.test(purpose+' '+label)) continue;
    const action = form.action, method = form.method, target = form.target;
    const attrs = ['formaction','formmethod','formtarget'].map(k => button.getAttribute(k));
    const destinationSafe = () => form.method.toLowerCase() === 'post' && loginDestination(form.action, amazonIdentifier) &&
      (!form.target || form.target === '_self') && (!button.hasAttribute('formaction') || loginDestination(button.formAction, amazonIdentifier)) &&
      (!button.hasAttribute('formmethod') || button.formMethod.toLowerCase() === 'post') && (!button.formTarget || button.formTarget === '_self');
    if (!destinationSafe()) continue;
    const types = inputs.map(e => e.type), names = inputs.map(e => e.name), ids = inputs.map(e => e.id);
    const identity = e => JSON.stringify([e.autocomplete,e.placeholder,e.getAttribute('aria-label'),Array.from(e.labels || []).map(text)]);
    const identities = inputs.map(identity), bodyText = form.textContent.slice(0,4000);
    const controlState = e => JSON.stringify([e.tagName,e.type,e.name,e === button ? null : e.disabled,e.checked,e.required,e.getAttribute('form'),inputs.includes(e) ? null : e.value]);
    const allControls = Array.from(form.elements).map(e => [e,controlState(e)]);
    const good = () => page.document === doc && location.href === url && location.origin === origin && visible(form) &&
      destinationSafe() && form.action === action && form.method === method && form.target === target &&
      attrs.every((v,i) => button.getAttribute(['formaction','formmethod','formtarget'][i]) === v) &&
      visible(button) && button.form === form && text(button) === label &&
      form.textContent.slice(0,4000) === bodyText &&
      form.elements.length === allControls.length && Array.from(form.elements).every((e,i) => e === allControls[i][0] && controlState(e) === allControls[i][1]) &&
      Array.from(form.querySelectorAll('input')).filter(e => visible(e) && !e.matches(':disabled') && !e.readOnly && !['hidden','submit','button','checkbox','radio'].includes(e.type)).every((e,i) => e === inputs[i]) &&
      Array.from(doc.querySelectorAll('h1,h2')).filter(visible).map(text).join(' ').slice(0,2000) === headings && inputs.every((e,i) => visible(e) &&
        !e.matches(':disabled') && !e.readOnly && e.form === form && e.type === types[i] && e.name === names[i] && e.id === ids[i] && identity(e) === identities[i]);
    candidates.push({ kinds, good, async fill(values) {
      if (!good() || values.length !== inputs.length) return false;
      const setter = Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype,'value').set;
      for (let i=0;i<inputs.length;i++) {
        if (!good()) return i === 0 ? false : 'changed';
        setter.call(inputs[i],values[i]);
        if (inputs[i].value !== values[i]) return i === 0 ? false : 'changed';
        inputs[i].dispatchEvent(new page.Event('input',{bubbles:true}));
        inputs[i].dispatchEvent(new page.Event('change',{bubbles:true}));
      }
      for (let i=0;i<40;i++) {
        if (!good()) return 'changed';
        if (!button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true') { button.click(); return true; }
        await new Promise(r => setTimeout(r,25));
      }
      return false;
    }});
  }
  if (candidates.length === 1) return bind ? candidates[0] : candidates[0].kinds;
  // Positive completion cue only; an absent form can also be a challenge/error.
  if (!candidates.length && !Array.from(doc.querySelectorAll('iframe,input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])')).some(visible) &&
      Array.from(doc.querySelectorAll('a,button')).some(e => visible(e) && /^(?:sign out|log out|logout)$/.test(text(e)))) return 'complete';
  return 'manual';
}`;
