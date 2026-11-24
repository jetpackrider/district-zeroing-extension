import { startHook } from '../hook/main';

/** MAIN-world hook: reads window.dra. Declared in the manifest so it runs before DRA's bundle. */
export default defineContentScript({
  matches: ['https://davesredistricting.org/*'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: false,
  main() {
    startHook();
  },
});
