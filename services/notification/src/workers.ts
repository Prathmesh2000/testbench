import { CHANNELS } from '@tb/contracts';
import type { DeliveryMessage, FallbackMessage } from './queues';
import { handleDelivery, handleFallback, type Deps } from './service';

/**
 * Long-polls every channel queue. In AWS each queue triggers its own Lambda with reserved concurrency;
 * locally one process runs a loop per queue, calling the same handlers (HLD §10: no Lambda emulation).
 */
export function startWorkers(deps: Deps): () => Promise<void> {
  let stopped = false;
  const loops = [
    ...CHANNELS.map((channel) =>
      (async () => {
        while (!stopped) {
          try {
            for (const got of await deps.queues.receive<DeliveryMessage>(channel, 10, 5))
              await handleDelivery(deps, channel, got);
          } catch (err) {
            deps.log.error({ err, channel }, 'queue poll failed');
            await new Promise((r) => setTimeout(r, 5_000));
          }
        }
      })(),
    ),
    (async () => {
      while (!stopped) {
        try {
          for (const got of await deps.queues.receive<FallbackMessage>('fallback', 10, 5))
            await handleFallback(deps, got);
        } catch (err) {
          deps.log.error({ err }, 'fallback poll failed');
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    })(),
  ];
  return async () => {
    stopped = true;
    await Promise.all(loops);
  };
}
