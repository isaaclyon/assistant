// Node's type stripping does not map emitted .js specifiers back to TS sources.
// This test-only hook permits the crash child to use the same typed production file.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try { return next(specifier, context); }
    catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return next(specifier.slice(0, -3) + '.ts', context); }
  }
  return next(specifier, context);
} });
