// Node's SSR tests do not render styles; keep CSS-module class names stable for markup checks.
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.module.css')) {
      return { format: 'module', shortCircuit: true, source: 'export default new Proxy({}, {get: (_, key) => String(key)});' };
    }
    return nextLoad(url, context);
  },
});
