import { expect, test } from 'vitest';
import { confirmationPresentation, formatDiagnostics, modelMenu, parseCallbackData, parseCommandText, redact, statusMenu, thinkingMenu, toReplyMarkup } from '../../src/durable/telegram-ui.js';

test('commands: known, aliases, arguments and unknown slash text never forward', () => {
  expect(parseCommandText('hello')).toEqual({ type: 'text' });
  expect(parseCommandText('/new')).toEqual({ type: 'control', name: 'new' });
  expect(parseCommandText('/Debug@my_bot')).toEqual({ type: 'ui', name: 'debug' });
  expect(parseCommandText('/start')).toEqual({ type: 'ui', name: 'menu' });
  expect(parseCommandText('/frobnicate')).toMatchObject({ type: 'unavailable', reason: 'unknown' });
  expect(parseCommandText('/new now')).toMatchObject({ type: 'unavailable', reason: 'arguments' });
  expect(parseCommandText('/ x')).toMatchObject({ type: 'unavailable' });
  expect(parseCommandText('/restart', new Set(['new']))).toMatchObject({ type: 'unavailable', reason: 'disabled' });
});
test('callback grammar accepts only known bounded actions', () => {
  expect(parseCallbackData('tl:max')).toEqual({ type: 'thinking', level: 'max' });
  expect(parseCallbackData('k:new')).toEqual({ type: 'control', name: 'new' });
  expect(parseCallbackData('cf:a:abcdefgh12345678')).toEqual({ type: 'confirmation', key: 'abcdefgh12345678', choice: 'approve' });
  for (const bad of ['tl:ultra', 'k:restart', 'cf:x:abcdefgh', 'cf:a:short', `mc:${'a'.repeat(60)}`, 'cf:a:abcdefgh:extra', 'tgbtn:1', '', undefined, 7]) expect(parseCallbackData(bad)).toBeUndefined();
});
test('menus keep callback data within Telegram limits and expose max thinking', () => {
  const choices = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}` }));
  const page = modelMenu(choices, 'm7', 1);
  expect(page.text).toContain('2/3');
  for (const row of toReplyMarkup(page.buttons)!.inline_keyboard) for (const b of row) expect(new TextEncoder().encode((b as { callback_data: string }).callback_data).length).toBeLessThanOrEqual(64);
  expect(JSON.stringify(thinkingMenu(['off', 'high', 'max', 'bogus'], 'high').buttons)).toContain('tl:max');
  expect(JSON.stringify(thinkingMenu(['off', 'bogus'], undefined).buttons)).not.toContain('bogus');
  expect(statusMenu({ model: 'x', busy: true }).buttons!.flat().map(b => b.text)).toContain('Abort');
  expect(() => toReplyMarkup([[{ text: 'x', callback: 'free-form' }]])).toThrow();
  expect(() => toReplyMarkup([[{ text: 'x', url: 'http://insecure.example' }]])).toThrow();
  expect(confirmationPresentation('abcdefgh12345678', 'Delete?').buttons![0]).toHaveLength(2);
  expect(() => confirmationPresentation('x'.repeat(64), 't')).toThrow();
});
test('diagnostics are redacted and bounded', () => {
  const secret = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const text = redact(`url https://x.test/p?token=abc path /Users/isaac/secret api_key=hunter2 Authorization: Bearer abcdefghijkl ${secret} ${'a'.repeat(64)}`);
  expect(text).not.toMatch(/hunter2|abcdefghijkl|AAAAAAAA|isaac|token=abc/);
  const out = formatDiagnostics(Array.from({ length: 20 }, (_, i) => ({ title: `s${i}`, lines: Array.from({ length: 200 }, () => 'x'.repeat(1000)) })));
  expect(out.text.length).toBeLessThanOrEqual(3500);
  expect(out.text).toContain('more');
});
