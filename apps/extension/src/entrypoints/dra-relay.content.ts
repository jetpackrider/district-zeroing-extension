import { startRelay } from '../hook/relay';

/** Isolated-world relay: private MessageChannel from the hook <-> runtime port to the panel. */
export default defineContentScript({
  matches: ['https://davesredistricting.org/*'],
  runAt: 'document_start',
  allFrames: false,
  main() {
    startRelay();
  },
});
